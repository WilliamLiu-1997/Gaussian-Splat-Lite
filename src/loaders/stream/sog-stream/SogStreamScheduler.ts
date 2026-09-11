import * as THREE from "three";
import {
  sogBatchAllocationSize,
  sogBatchTextureLayout,
} from "../../../data/SogRegionSplats";
import type { SplatResult } from "../../../data/defines";
import {
  getSplatByteLength,
  getSplatShDegree,
  getSplatTextureBytes,
} from "../../../data/splatData";
import { StreamByteBudget } from "../StreamByteBudget";
import {
  type StreamSchedulerOptions,
  type StreamStats,
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  retryDelay,
  streamPendingLimit,
  streamSettings,
} from "../streamOptions";
import { SogStreamBatch } from "./SogStreamBatch";
import {
  type SogChunkSource,
  SogStreamLoader,
  type SogStreamLoaderOptions,
} from "./SogStreamLoader";
import {
  SOG_LOD_STRIDE,
  type SogLodFile,
  type SogLodLeaf,
  type SogLodMetadata,
  type SogLodRange,
  readSogLodLeaf,
  resolveSogLod,
} from "./sogLod";
import { type SogView, captureSogView } from "./sogVisibility";

export type SogStreamSchedulerOptions = SogStreamLoaderOptions &
  StreamSchedulerOptions;
export type SogStreamStats = StreamStats & { visibleRegions: number };

type Chunk = {
  file: SogLodFile;
  /** Stable slots keep a chunk together regardless of region arrival order. */
  batchSlots: Map<number, number>;
  batchCapacity: number;
  batch?: SogStreamBatch;
  data?: SogChunkSource;
  controller?: AbortController;
  expiresAt?: number;
  failures: number;
  retryAt: number;
};

type Region = {
  batch: SogStreamBatch;
  start: number;
  range: SogLodRange;
  opacity: number;
  expiresAt?: number;
};

type PendingRegion = {
  range: SogLodRange;
  chunk: Chunk;
  bytes: number;
  data?: SplatResult;
};

type LeafState = {
  target?: SogLodRange;
  current?: Region;
  /** Keep at most one previous LOD until its fade-out finishes. */
  outgoing?: Region;
  pending?: PendingRegion;
};

const EMPTY_SELECTION = new Uint32Array(0);

/** Camera-driven Streamed SOG loading with per-chunk sources and region fades. */
export class SogStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly cooldownTicks: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  readonly maxUploadBytesPerUpdate: number;

  private _splatBudget: number;
  private readonly options: SogStreamSchedulerOptions;
  private readonly loader: SogStreamLoader;
  private readonly abort = new AbortController();
  private manifest?: SogLodMetadata;
  private readonly lodLeaves = new Map<number, SogLodLeaf>();
  private view?: SogView;
  private lastRequestedKey = "";
  private selecting = false;
  private selection: Uint32Array = EMPTY_SELECTION;
  private chunks: Chunk[] = [];
  /** Chunks with a batch, cached source or in-flight load. */
  private readonly activeChunks = new Set<Chunk>();
  private environment?: Chunk;
  private leaves = new Map<number, LeafState>();
  private wanted = new Set<Chunk>();
  private readonly fades = new Map<
    Region,
    { from: number; to: number; startedAt: number }
  >();
  private tick = 0;
  private shown = true;
  private disposed = false;
  private resolveFirst!: (value: this) => void;
  private rejectFirst!: (error: unknown) => void;

  constructor(options: SogStreamSchedulerOptions) {
    this.options = { ...options };
    this.group = options.group ?? new THREE.Group();
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this.cooldownTicks = settings.cooldownTicks;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.maxUploadBytesPerUpdate = settings.maxUploadBytesPerUpdate;
    this.loader = new SogStreamLoader(
      this.options,
      this.maxConcurrentLoads,
      () => this.changed(),
    );
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.initialized = this.initialize().catch((error) => {
      this.rejectFirst(error);
      this.loader.dispose();
      throw error;
    });
    // Both readiness promises are optional to observe; errors remain available
    // to callers awaiting them and chunk failures go through onError.
    void this.initialized.catch(() => {});
    void this.firstRenderable.catch(() => {});
  }

  /** Visible-point target, including the environment. Reassign to reselect LODs. */
  get splatBudget(): number {
    return this._splatBudget;
  }

  set splatBudget(value: number) {
    if (value === this._splatBudget) return;
    this._splatBudget = positiveInteger(value, "splatBudget");
    void this.requestSelection();
  }

  get stats(): SogStreamStats {
    const { retainedIndexBytes, ...loaderStats } = this.loader.stats;
    const manifest = this.manifest;
    const stats: SogStreamStats = {
      visibleSplats: 0,
      visibleRegions: 0,
      visibleMeshes: 0,
      residentMeshes: 0,
      residentChunks: 0,
      residentBytes:
        retainedIndexBytes +
        (manifest
          ? manifest.bounds.byteLength +
            manifest.leafOffsets.byteLength +
            manifest.lods.byteLength +
            manifest.counts.byteLength
          : 0),
      pendingBytes: 0,
      loadingChunks: 0,
      ...loaderStats,
    };
    for (const { batch, data, controller } of this.activeChunks) {
      if (batch) {
        stats.residentMeshes++;
        stats.residentBytes += batch.residentBytes;
        if (this.shown && batch.numSplats > 0) {
          stats.visibleMeshes++;
          stats.visibleSplats += batch.numSplats;
        }
      }
      if (data?.alive) {
        stats.residentChunks++;
        stats.residentBytes += data.info.byteLength;
      }
      if (controller) stats.loadingChunks++;
    }
    for (const { current, outgoing, pending } of this.leaves.values()) {
      stats.pendingBytes += pending?.bytes ?? 0;
      if (this.shown) {
        if (current && Math.fround(current.opacity) > 0) stats.visibleRegions++;
        if (outgoing && Math.fround(outgoing.opacity) > 0)
          stats.visibleRegions++;
      }
    }
    return stats;
  }

  /** Group-local bounds from the index; available after initialized resolves. */
  getBoundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    if (this.manifest) {
      box.min.fromArray(this.manifest.bounds, 0);
      box.max.fromArray(this.manifest.bounds, 3);
    }
    return box;
  }

  private async initialize(): Promise<this> {
    const manifest = await this.loader.initialize(this.abort.signal);
    this.abort.signal.throwIfAborted();
    this.manifest = manifest;
    const files: SogLodFile[] = manifest.urls.map((url, index) => ({
      url,
      count: manifest.counts[index],
      ranges: [],
    }));
    if (this.manifest.environment)
      files.push({ url: this.manifest.environment, count: -1, ranges: [] });
    this.chunks = files.map((file) => ({
      file,
      batchSlots: new Map(),
      batchCapacity: 0,
      failures: 0,
      retryAt: 0,
    }));
    for (
      let offset = 0;
      offset < manifest.lods.length;
      offset += SOG_LOD_STRIDE
    ) {
      this.addBatchRange(
        this.chunks[manifest.lods[offset + 1]],
        manifest.lods[offset + 2],
        manifest.lods[offset + 3],
      );
    }
    if (this.manifest.environment)
      this.environment = this.chunks[this.chunks.length - 1];
    if (!this.environment && !this.manifest.lods.length)
      this.resolveFirst(this);
    this.changed();
    return this;
  }

  /** Call before rendering. Returns whether the displayed data changed. */
  update(camera: THREE.Camera): boolean {
    if (this.disposed || !this.manifest) return false;
    this.tick++;
    for (const chunk of this.activeChunks) {
      this.pruneChunk(chunk);
      chunk.batch?.beginUpdate();
    }
    this.view = captureSogView(camera, this.group);
    const { shown } = this.view;
    this.shown = shown;
    if (!shown) {
      this.selection = EMPTY_SELECTION;
      this.lastRequestedKey = "";
    }
    const now = performance.now();
    const { selected, refinements } = this.selectRegions();
    const changed = this.applySelection(selected, now);
    this.updateRequests(refinements, now);
    this.releaseUnused();
    if (
      shown &&
      [...this.leaves.values()].some(
        ({ current, outgoing }) =>
          (current?.opacity ?? 0) > 0 || (outgoing?.opacity ?? 0) > 0,
      )
    )
      this.resolveFirst(this);
    void this.requestSelection();
    if (changed) this.changed();
    return changed;
  }

  private async requestSelection() {
    const view = this.view;
    if (
      this.disposed ||
      !this.shown ||
      this.selecting ||
      !this.manifest?.lods.length ||
      !view
    )
      return;
    const splatBudget = this.splatBudget;
    const budget = Math.max(
      0,
      splatBudget - Math.max(0, this.environment?.file.count ?? 0),
    );
    const key = `${view.modelView.join(",")}/${view.projection.join(",")}/${view.coordinateSystem}/${view.reversedDepth}/${splatBudget}/${budget}`;
    if (key === this.lastRequestedKey) return;
    this.lastRequestedKey = key;
    this.selecting = true;
    try {
      const selection = await this.loader.selectLod(view, budget);
      if (this.disposed || !this.shown || splatBudget !== this.splatBudget)
        return;
      // Keep one completed result; accepting camera lag avoids starving motion.
      // Resolve it against current caches, never worker-time resource snapshots.
      this.selection = selection;
      const { selected, refinements } = this.selectRegions();
      const now = performance.now();
      this.queueExtractions(selected, now);
      this.updateRequests(refinements, now);
      this.changed();
    } catch (error) {
      if (!this.disposed) {
        this.rejectFirst(error);
        this.failed(error, this.options.url);
      }
    } finally {
      this.selecting = false;
      // Updates replace the latest view while this task runs; no request queue.
      void this.requestSelection();
    }
  }

  private updateRequests(refinements: [LeafState, Chunk][], now: number) {
    // Establish coverage before starting the next LOD request.
    for (const [leaf, chunk] of refinements) {
      if (leaf.current?.range === leaf.target) this.wanted.add(chunk);
    }
    for (const chunk of this.activeChunks) {
      if (chunk.controller && !this.wanted.has(chunk)) chunk.controller.abort();
    }
    this.pump(now);
  }

  private selectRegions() {
    for (const leaf of this.leaves.values()) leaf.target = undefined;
    const selected: LeafState[] = [];
    this.wanted.clear();
    const show = (range: SogLodRange) => {
      const leaf = this.leafState(range.leaf);
      leaf.target = range;
      selected.push(leaf);
      if (leaf.current?.range !== range) this.wanted.add(this.chunkFor(range));
    };
    if (this.shown && this.environment) {
      const current = this.leaves.get(-1)?.current;
      const range = current?.range ?? this.environment.file.ranges[0];
      if (range && (current || this.environment.data?.alive)) show(range);
      else if (this.environment.file.count !== 0)
        this.wanted.add(this.environment);
    }
    const refinements: [LeafState, Chunk][] = [];
    for (
      let offset = 0;
      this.shown && offset < this.selection.length;
      offset += 2
    ) {
      const id = this.selection[offset];
      let leaf = this.lodLeaves.get(id);
      if (!leaf) {
        leaf = readSogLodLeaf(this.manifest as SogLodMetadata, id);
        this.lodLeaves.set(id, leaf);
      }
      const target = leaf.lods[this.selection[offset + 1]];
      const state = this.leafState(leaf.id);
      const { range, load, refinement } = resolveSogLod(
        leaf,
        target,
        state.current?.range,
        (lod) => this.chunks[lod.file].data?.alive === true,
      );
      if (range) show(range);
      if (load) {
        const chunk = this.chunks[load.file];
        if (range && refinement) refinements.push([state, chunk]);
        else this.wanted.add(chunk);
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.pending?.data && leaf.target !== leaf.pending.range)
        leaf.pending = undefined;
    }
    return { selected, refinements };
  }

  private leafState(id: number) {
    let leaf = this.leaves.get(id);
    if (!leaf) {
      leaf = {};
      this.leaves.set(id, leaf);
    }
    return leaf;
  }

  private chunkFor(range: SogLodRange) {
    return range.file < 0
      ? (this.environment as Chunk)
      : this.chunks[range.file];
  }

  private applySelection(selected: LeafState[], now: number) {
    // Advance an existing fade before reversing it to avoid opacity jumps.
    let changed = this.updateFades(now);
    changed = this.updateRegionVisibility(now) || changed;
    changed = this.attachPendingRegions(selected, now) || changed;
    this.queueExtractions(selected, now);
    // Complete zero-duration fades in this update as well.
    return this.updateFades(now) || changed;
  }

  private updateRegionVisibility(now: number) {
    let changed = false;
    for (const leaf of this.leaves.values()) {
      const { current, outgoing, target } = leaf;
      if (current) changed = this.fadeRegion(current, !!target, now) || changed;
      if (outgoing) changed = this.fadeRegion(outgoing, false, now) || changed;
    }
    return changed;
  }

  private attachPendingRegions(selected: LeafState[], now: number) {
    let changed = false;
    const uploads = new StreamByteBudget(this.maxUploadBytesPerUpdate);
    for (const leaf of selected) {
      const { current, pending, target: range } = leaf;
      // Finish a crossfade before admitting another LOD for this region.
      if (
        !range ||
        current?.range === range ||
        leaf.outgoing ||
        pending?.range !== range ||
        !pending.data
      )
        continue;

      const { data, chunk } = pending;
      const start = chunk.batchSlots.get(range.offset);
      if (start === undefined) throw new Error("Missing chunk region slot");
      const count = data.numSplats;
      const numSh = getSplatShDegree(data.extra);
      let batch = chunk.batch;
      let bytes: number;
      if (batch) bytes = batch.uploadBytes(start, count);
      else {
        const { capacity } = sogBatchTextureLayout(chunk.batchCapacity);
        bytes =
          getSplatTextureBytes(capacity, numSh) + (capacity / 64) * 4 + 16;
      }
      if (!uploads.reserve(bytes)) continue;
      if (!batch) {
        batch = new SogStreamBatch(
          chunk.batchCapacity,
          numSh,
          this.group,
          () => {
            chunk.batch = undefined;
            this.pruneChunk(chunk);
          },
        );
        batch.name =
          range.file < 0 ? "sog-environment" : `sog-chunk-${range.file}`;
        chunk.batch = batch;
        this.activeChunks.add(chunk);
      }
      batch.writeRegion(start, data);
      leaf.pending = undefined;
      if (current) {
        leaf.outgoing = current;
        this.fadeRegion(current, false, now);
      }
      leaf.current = { batch, start, range, opacity: 0 };
      this.fadeRegion(leaf.current, true, now);
      changed = true;
    }
    return changed;
  }

  private queueExtractions(selected: LeafState[], now: number) {
    // Bound both in-flight and ready copies by their compact packed byte size.
    // One indivisible oversized region may occupy the queue on its own.
    let pendingBytes = 0;
    for (const leaf of this.leaves.values())
      pendingBytes += leaf.pending?.bytes ?? 0;
    const budget = new StreamByteBudget(
      streamPendingLimit(this.maxConcurrentLoads, this.maxUploadBytesPerUpdate),
      pendingBytes,
    );
    const batches = new Map<Chunk, PendingRegion[]>();
    for (const leaf of selected) {
      const range = leaf.target;
      if (!range || leaf.current?.range === range || leaf.pending) continue;
      const chunk = this.chunkFor(range);
      if (!chunk.data?.alive || now < chunk.retryAt) continue;
      const bytes = getSplatTextureBytes(range.count, chunk.data.info.numSh);
      if (!budget.reserve(bytes)) continue;
      const pending = { range, chunk, bytes };
      leaf.pending = pending;
      const batch = batches.get(chunk) ?? [];
      batch.push(pending);
      batches.set(chunk, batch);
    }
    for (const [chunk, batch] of batches) void this.extract(chunk, batch);
  }

  private addBatchRange(chunk: Chunk, offset: number, count: number) {
    if (!count || chunk.batchSlots.has(offset)) return;
    chunk.batchSlots.set(offset, chunk.batchCapacity);
    chunk.batchCapacity += sogBatchAllocationSize(count);
  }

  private fadeRegion(region: Region, visible: boolean, now: number) {
    const to = visible ? 1 : 0;
    if ((this.fades.get(region)?.to ?? region.opacity) === to) return false;
    this.fades.set(region, { from: region.opacity, to, startedAt: now });
    return true;
  }

  private updateFades(now: number) {
    let changed = false;
    for (const [region, fade] of this.fades) {
      const progress =
        this.fadeDurationMs === 0 || fade.from === fade.to
          ? 1
          : THREE.MathUtils.clamp(
              (now - fade.startedAt) / this.fadeDurationMs,
              0,
              1,
            );
      const opacity = THREE.MathUtils.lerp(fade.from, fade.to, progress);
      if (region.opacity !== opacity) {
        region.opacity = opacity;
        region.batch.setRegionOpacity(region.start, opacity);
        changed = true;
      }
      if (progress === 1) {
        this.fades.delete(region);
        if (this.leaves.get(region.range.leaf)?.outgoing === region)
          this.releaseRegion(region);
        changed = true;
      }
    }
    return changed;
  }

  private async extract(chunk: Chunk, batch: PendingRegion[]) {
    try {
      const source = chunk.data;
      if (!source?.alive)
        throw new Error("Streaming chunk is no longer cached");
      const results = await source.extract(
        batch.map(({ range }) => ({
          start: range.offset,
          count: range.count,
        })),
      );
      for (let index = 0; index < batch.length; index++) {
        const pending = batch[index];
        const { range } = pending;
        const data = results[index];
        const leaf = this.leaves.get(range.leaf);
        if (
          !this.disposed &&
          leaf?.pending === pending &&
          leaf.target === range
        ) {
          pending.data = data;
          pending.bytes = getSplatByteLength(data);
        } else if (leaf?.pending === pending) leaf.pending = undefined;
      }
    } catch (error) {
      for (const pending of batch) {
        const leaf = this.leaves.get(pending.range.leaf);
        if (leaf?.pending === pending) leaf.pending = undefined;
      }
      if (!this.disposed) {
        chunk.retryAt = performance.now() + 1000;
        this.failed(error, chunk.file.url);
      }
    } finally {
      if (!this.disposed) {
        this.pump(performance.now());
        this.changed();
      }
    }
  }

  private releaseUnused() {
    const referenced = new Set(this.wanted);
    for (const [id, leaf] of this.leaves) {
      const { current, outgoing, pending } = leaf;
      if (pending) referenced.add(pending.chunk);
      if (outgoing) referenced.add(this.chunkFor(outgoing.range));
      if (current) {
        if (current.opacity > 0 || this.fades.has(current) || outgoing) {
          current.expiresAt = undefined;
          referenced.add(this.chunkFor(current.range));
        } else {
          current.expiresAt ??= this.tick + this.cooldownTicks;
          if (this.tick >= current.expiresAt) this.releaseRegion(current);
        }
      }
      if (!leaf.target && !leaf.current && !leaf.outgoing && !leaf.pending)
        this.leaves.delete(id);
    }
    for (const chunk of this.activeChunks) {
      if (referenced.has(chunk) || chunk.controller || !chunk.data) {
        chunk.expiresAt = undefined;
      } else {
        chunk.expiresAt ??= this.tick + this.cooldownTicks;
        if (this.tick >= chunk.expiresAt) {
          chunk.data.dispose();
          this.pruneChunk(chunk);
        }
      }
    }
  }

  private pump(now: number) {
    if (this.disposed) return;
    let loading = 0;
    for (const chunk of this.activeChunks) {
      this.pruneChunk(chunk);
      if (chunk.controller) loading++;
    }
    for (const chunk of this.wanted) {
      if (loading >= this.maxConcurrentLoads) break;
      if (chunk.data || chunk.controller || now < chunk.retryAt) continue;
      chunk.controller = new AbortController();
      this.activeChunks.add(chunk);
      loading++;
      void this.load(chunk, chunk.controller);
    }
  }

  private async load(chunk: Chunk, controller: AbortController) {
    let decoded: SogChunkSource | undefined;
    try {
      decoded = await this.loader.load(
        chunk.file.url,
        chunk.file.count,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (chunk.batch && decoded.info.numSh !== chunk.batch.numSh)
        throw new Error(
          `Chunk SH degree mismatch: expected ${chunk.batch.numSh}, received ${decoded.info.numSh}`,
        );
      if (chunk === this.environment) {
        chunk.file.count = decoded.info.numSplats;
        this.addBatchRange(chunk, 0, chunk.file.count);
        chunk.file.ranges = chunk.file.count
          ? [
              {
                leaf: -1,
                level: 0,
                file: -1,
                offset: 0,
                count: chunk.file.count,
              },
            ]
          : [];
      } else if (decoded.info.numSplats !== chunk.file.count) {
        throw new Error(
          `Chunk count mismatch: expected ${chunk.file.count}, received ${decoded.info.numSplats}`,
        );
      }
      chunk.data = decoded;
      decoded = undefined;
      chunk.expiresAt = undefined;
      chunk.failures = 0;
      chunk.retryAt = 0;
      if (
        chunk === this.environment &&
        !chunk.file.count &&
        !this.manifest?.lods.length
      )
        this.resolveFirst(this);
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        chunk.retryAt = performance.now() + retryDelay(chunk.failures++);
        this.failed(error, chunk.file.url);
      }
    } finally {
      decoded?.dispose();
      chunk.controller = undefined;
      this.pruneChunk(chunk);
      // Refill without waiting for update(); defer to avoid recursive failures
      // when a custom loader throws synchronously.
      if (!this.disposed)
        queueMicrotask(() => {
          this.pump(performance.now());
          // Loading the environment changes the budget available to LOD.
          if (chunk === this.environment) void this.requestSelection();
          this.changed();
        });
    }
  }

  private pruneChunk(chunk: Chunk) {
    if (chunk.data && !chunk.data.alive) chunk.data = undefined;
    if (!chunk.data) chunk.expiresAt = undefined;
    if (!chunk.batch && !chunk.data && !chunk.controller)
      this.activeChunks.delete(chunk);
  }

  private releaseRegion(region: Region) {
    this.fades.delete(region);
    region.batch.releaseRegion(region.start);
    const leaf = this.leaves.get(region.range.leaf);
    if (leaf?.current === region) leaf.current = undefined;
    if (leaf?.outgoing === region) leaf.outgoing = undefined;
  }

  private changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }

  private failed(error: unknown, url: string) {
    notifyStreamError(this.options, error, url);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.rejectFirst(this.abort.signal.reason);
    this.loader.dispose();
    for (const chunk of this.activeChunks) {
      chunk.controller?.abort();
      chunk.data?.dispose();
      chunk.data = undefined;
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.current) this.releaseRegion(leaf.current);
      if (leaf.outgoing) this.releaseRegion(leaf.outgoing);
    }
    this.leaves.clear();
    this.fades.clear();
    this.wanted.clear();
    this.chunks = [];
    this.activeChunks.clear();
    this.environment = undefined;
    this.manifest = undefined;
    this.lodLeaves.clear();
    this.view = undefined;
    this.selection = EMPTY_SELECTION;
  }
}
