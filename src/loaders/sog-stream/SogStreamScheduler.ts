import * as THREE from "three";
import type { Splats } from "../../data/Splats";
import { getSplatTextureBytes } from "../../data/splatData";
import { getTextureSize } from "../../data/textureLayout";
import { getAssetBaseUrl } from "../assetUrl";
import {
  SogStreamBatch,
  sogBatchAllocationSize,
  sogBatchTextureLayout,
} from "./SogStreamBatch";
import { type SogChunkSource, SogStreamLoader } from "./SogStreamLoader";
import {
  type SogLodFile,
  type SogLodIndex,
  type SogLodRange,
  type SogVisibleLeaf,
  resolveSogLod,
  selectSogLods,
} from "./sogLod";
import { SogVisibility } from "./sogVisibility";

export type SogStreamSchedulerOptions = {
  url: string;
  group?: THREE.Group;
  splatBudget?: number;
  /** Updates to retain unused chunks and regions after fade-out. */
  cooldownTicks?: number;
  /** Region opacity transition duration in milliseconds; zero switches immediately. */
  fadeDurationMs?: number;
  maxConcurrentLoads?: number;
  /** Source texture bytes attached per update; one oversized region may progress. */
  maxUploadBytesPerUpdate?: number;
  manager?: THREE.LoadingManager;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  onChange?: () => void;
  onError?: (error: unknown, url: string) => void;
  /** Optional transport override; returns owned data in the original storage order. */
  loadChunk?: (url: string, signal: AbortSignal) => Promise<Splats>;
};

export type SogStreamStats = {
  visibleSplats: number;
  visibleRegions: number;
  visibleMeshes: number;
  residentMeshes: number;
  residentChunks: number;
  residentBytes: number;
  loadingChunks: number;
};

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
  fade?: {
    from: number;
    to: number;
    startedAt: number;
  };
  expiresAt?: number;
};

type PendingRegion = {
  range: SogLodRange;
  chunk: Chunk;
  bytes: number;
  data?: Splats;
};

type LeafState = {
  target?: SogLodRange;
  current?: Region;
  /** Keep at most one previous LOD until its fade-out finishes. */
  outgoing?: Region;
  pending?: PendingRegion;
};

type RegionPlan = {
  chunk: Chunk;
  start: number;
  bytes: number;
};

function isRegionActive(region: Region) {
  return region.opacity > 0 || !!region.fade;
}

function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/** Camera-driven Streamed SOG loading with per-chunk sources and region fades. */
export class SogStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly splatBudget: number;
  readonly cooldownTicks: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  readonly maxUploadBytesPerUpdate: number;

  private readonly options: SogStreamSchedulerOptions;
  private readonly loader: SogStreamLoader;
  private readonly abort = new AbortController();
  private manifest?: SogLodIndex;
  private visibility?: SogVisibility;
  private chunks: Chunk[] = [];
  private environment?: Chunk;
  private leaves = new Map<number, LeafState>();
  private wanted = new Set<Chunk>();
  private tick = 0;
  private disposed = false;
  private resolveFirst!: (value: this) => void;
  private rejectFirst!: (error: unknown) => void;
  private baseUrl = "";

  constructor(options: SogStreamSchedulerOptions) {
    this.options = { ...options };
    this.loader = new SogStreamLoader(this.options, () => this.changed());
    this.group = options.group ?? new THREE.Group();
    this.splatBudget = positive(
      options.splatBudget ?? 3_000_000,
      "splatBudget",
    );
    this.cooldownTicks = options.cooldownTicks ?? 100;
    if (!Number.isSafeInteger(this.cooldownTicks) || this.cooldownTicks < 0)
      throw new Error("cooldownTicks must be a nonnegative safe integer");
    this.fadeDurationMs = options.fadeDurationMs ?? 200;
    if (!Number.isFinite(this.fadeDurationMs) || this.fadeDurationMs < 0)
      throw new Error("fadeDurationMs must be finite and nonnegative");
    this.maxConcurrentLoads = positive(
      options.maxConcurrentLoads ?? 2,
      "maxConcurrentLoads",
    );
    this.maxUploadBytesPerUpdate = positive(
      options.maxUploadBytesPerUpdate ?? 8 * 1024 * 1024,
      "maxUploadBytesPerUpdate",
    );
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.initialized = this.initialize().catch((error) => {
      this.rejectFirst(error);
      throw error;
    });
    // Both readiness promises are optional to observe; errors remain available
    // to callers awaiting them and chunk failures go through onError.
    void this.initialized.catch(() => {});
    void this.firstRenderable.catch(() => {});
  }

  get stats(): SogStreamStats {
    const leaves = [...this.leaves.values()];
    const active = leaves
      .flatMap(({ current, outgoing }) => [current, outgoing])
      .filter((region): region is Region => !!region && isRegionActive(region));
    return {
      visibleSplats: active.reduce(
        (count, region) => count + region.range.count,
        0,
      ),
      visibleRegions: active.length,
      visibleMeshes: new Set(active.map(({ batch }) => batch)).size,
      residentMeshes: this.chunks.filter((chunk) => chunk.batch).length,
      residentChunks: this.chunks.filter((chunk) => chunk.data?.alive).length,
      residentBytes:
        this.chunks.reduce(
          (bytes, chunk) =>
            bytes + (chunk.data?.alive ? chunk.data.info.byteLength : 0),
          0,
        ) +
        this.chunks.reduce(
          (bytes, chunk) => bytes + (chunk.batch?.residentBytes ?? 0),
          0,
        ) +
        leaves.reduce(
          (bytes, leaf) => bytes + (leaf.pending?.data?.getByteLength() ?? 0),
          0,
        ),
      loadingChunks: this.chunks.filter(
        (chunk) => chunk.controller !== undefined,
      ).length,
    };
  }

  /** Scene-local bounds from the index; available after initialized resolves. */
  getBoundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    if (this.manifest) {
      box.min.fromArray(this.manifest.nodes, 0);
      box.max.fromArray(this.manifest.nodes, 3);
    }
    return box;
  }

  private async initialize(): Promise<this> {
    const manager = this.options.manager ?? THREE.DefaultLoadingManager;
    const resolveBase =
      typeof document === "undefined" ? undefined : document.baseURI;
    const url = new URL(manager.resolveURL(this.options.url), resolveBase).href;
    const resourceUrl = new URL(this.options.url, resolveBase ?? url).href;
    this.baseUrl = getAssetBaseUrl(url) ?? resourceUrl;
    manager.itemStart(url);
    try {
      const response = await fetch(url, {
        headers: this.options.requestHeader,
        credentials: this.options.withCredentials ? "include" : "same-origin",
        signal: this.abort.signal,
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status} loading ${url}`);
      const bytes = await response.arrayBuffer();
      const manifest = await this.loader.parseIndex(
        bytes,
        getAssetBaseUrl(response.url || url) ?? resourceUrl,
        this.abort.signal,
      );
      this.abort.signal.throwIfAborted();
      this.manifest = manifest;
      this.visibility = new SogVisibility(manifest);
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
      for (let offset = 0; offset < manifest.lods.length; offset += 6) {
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
    } catch (error) {
      manager.itemError(url);
      throw error;
    } finally {
      manager.itemEnd(url);
    }
  }

  /** Call before rendering. Returns whether the displayed data changed. */
  update(camera: THREE.Camera): boolean {
    if (this.disposed || !this.visibility) return false;
    this.tick++;
    for (const chunk of this.chunks) {
      if (chunk.data && !chunk.data.alive) chunk.data = undefined;
      chunk.batch?.beginUpdate();
    }
    const { shown, visible } = this.visibility.collect(camera, this.group);
    const now = performance.now();
    const { selected, refinements } = this.selectRegions(shown, visible);
    const changed = this.applySelection(selected, now);
    for (const [leaf, chunk] of refinements) {
      if (leaf.current?.range === leaf.target) this.wanted.add(chunk);
    }
    for (const chunk of this.chunks) {
      if (chunk.controller && !this.wanted.has(chunk)) chunk.controller.abort();
    }
    this.releaseUnused();
    if (
      shown &&
      [...this.leaves.values()].some(
        ({ current, outgoing }) =>
          (current?.opacity ?? 0) > 0 || (outgoing?.opacity ?? 0) > 0,
      )
    )
      this.resolveFirst(this);
    this.pump(now);
    if (changed) this.changed();
    return changed;
  }

  private selectRegions(shown: boolean, visible: SogVisibleLeaf[]) {
    for (const leaf of this.leaves.values()) leaf.target = undefined;
    const environmentCount = shown
      ? Math.max(0, this.environment?.file.count ?? 0)
      : 0;
    const targets = selectSogLods(
      visible,
      Math.max(0, this.splatBudget - environmentCount),
    );
    const selected: LeafState[] = [];
    this.wanted.clear();
    const show = (range: SogLodRange) => {
      const leaf = this.leafState(range.leaf);
      leaf.target = range;
      selected.push(leaf);
      if (leaf.current?.range !== range) this.wanted.add(this.chunkFor(range));
    };
    if (shown && this.environment) {
      const current = this.leaves.get(-1)?.current;
      const range = current?.range ?? this.environment.file.ranges[0];
      if (range && (current || this.environment.data)) show(range);
      else if (this.environment.file.count !== 0)
        this.wanted.add(this.environment);
    }
    // Shared files load once. Show the best loaded level no finer than the
    // target, then halve the remaining LOD gap; keep the old LOD during a switch.
    const refinements: [LeafState, Chunk][] = [];
    visible.sort((a, b) => b.weight - a.weight || a.leaf.id - b.leaf.id);
    for (const { leaf } of visible) {
      const target = targets.get(leaf.id);
      if (!target) continue;
      const state = this.leafState(leaf.id);
      const { range, load, refinement } = resolveSogLod(
        leaf,
        target,
        state.current?.range,
        (lod) => !!this.chunks[lod.file].data,
      );
      if (range) show(range);
      if (load) {
        const chunk = this.chunks[load.file];
        if (range && refinement) refinements.push([state, chunk]);
        else this.wanted.add(chunk);
      }
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
      const { current, outgoing, pending, target } = leaf;
      if (pending?.data && target !== pending.range) {
        pending.data.dispose();
        leaf.pending = undefined;
      }
      if (current) changed = this.fadeRegion(current, !!target, now) || changed;
      if (outgoing) changed = this.fadeRegion(outgoing, false, now) || changed;
    }
    return changed;
  }

  private attachPendingRegions(selected: LeafState[], now: number) {
    let changed = false;
    let attachedBytes = 0;
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

      const data = pending.data;
      const plan = this.planRegion(range, data);
      if (
        attachedBytes &&
        attachedBytes + plan.bytes > this.maxUploadBytesPerUpdate
      )
        continue;
      const replacement = this.createRegion(range, data, plan);
      leaf.pending = undefined;
      attachedBytes += plan.bytes;
      if (current) {
        leaf.outgoing = current;
        this.fadeRegion(current, false, now);
      }
      leaf.current = replacement;
      this.fadeRegion(replacement, true, now);
      changed = true;
    }
    return changed;
  }

  private queueExtractions(selected: LeafState[], now: number) {
    // Bound both in-flight and ready copies by the same texture byte allowance.
    // One indivisible oversized region may occupy the queue on its own.
    let pendingBytes = 0;
    for (const leaf of this.leaves.values())
      pendingBytes += leaf.pending?.bytes ?? 0;
    const batches = new Map<Chunk, PendingRegion[]>();
    for (const leaf of selected) {
      const range = leaf.target;
      if (!range || leaf.current?.range === range || leaf.pending) continue;
      const chunk = this.chunkFor(range);
      if (!chunk.data?.alive || now < chunk.retryAt) continue;
      const bytes = getSplatTextureBytes(
        getTextureSize(range.count).maxSplats,
        chunk.data.info.numSh,
      );
      if (pendingBytes && pendingBytes + bytes > this.maxUploadBytesPerUpdate)
        continue;
      const pending = { range, chunk, bytes };
      leaf.pending = pending;
      pendingBytes += bytes;
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

  private planRegion(range: SogLodRange, data: Splats): RegionPlan {
    const count = data.getNumSplats();
    const numSh = data.getNumSh();
    const chunk = this.chunkFor(range);
    const start = chunk.batchSlots.get(range.offset);
    const batch = chunk.batch;
    if (start === undefined) throw new Error("Missing chunk region slot");
    const { layerSize } = sogBatchTextureLayout(chunk.batchCapacity);
    return {
      chunk,
      start,
      bytes: batch
        ? batch.uploadBytes(start, count)
        : (Math.ceil((start + count) / layerSize) -
            Math.floor(start / layerSize)) *
          getSplatTextureBytes(layerSize, numSh),
    };
  }

  private createRegion(
    range: SogLodRange,
    data: Splats,
    plan: RegionPlan,
  ): Region {
    let batch = plan.chunk.batch;
    if (!batch) {
      batch = new SogStreamBatch(
        plan.chunk.batchCapacity,
        data.getNumSh(),
        this.group,
        () => {
          plan.chunk.batch = undefined;
        },
      );
      batch.name =
        range.file < 0 ? "sog-environment" : `sog-chunk-${range.file}`;
      plan.chunk.batch = batch;
    }
    batch.writeRegion(plan.start, data);
    return { batch, start: plan.start, range, opacity: 0 };
  }

  private fadeRegion(region: Region, visible: boolean, now: number) {
    const to = visible ? 1 : 0;
    if ((region.fade?.to ?? region.opacity) === to) return false;
    region.fade = { from: region.opacity, to, startedAt: now };
    return true;
  }

  private updateFades(now: number) {
    let changed = false;
    for (const leaf of this.leaves.values()) {
      for (const region of [leaf.current, leaf.outgoing]) {
        if (!region?.fade) continue;
        const fade = region.fade;
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
          region.fade = undefined;
          if (leaf.outgoing === region) this.releaseRegion(region);
          changed = true;
        }
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
        } else {
          data.dispose();
          if (leaf?.pending === pending) leaf.pending = undefined;
        }
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
        if (isRegionActive(current) || outgoing) {
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
    for (const chunk of this.chunks) {
      if (referenced.has(chunk) || chunk.controller || !chunk.data) {
        chunk.expiresAt = undefined;
      } else {
        chunk.expiresAt ??= this.tick + this.cooldownTicks;
        if (this.tick >= chunk.expiresAt) {
          chunk.data.dispose();
          chunk.data = undefined;
          chunk.expiresAt = undefined;
        }
      }
    }
  }

  private pump(now: number) {
    if (this.disposed) return;
    let loading = 0;
    for (const chunk of this.chunks) {
      if (chunk.data && !chunk.data.alive) chunk.data = undefined;
      if (chunk.controller) loading++;
    }
    for (const chunk of this.wanted) {
      if (loading >= this.maxConcurrentLoads) break;
      if (chunk.data || chunk.controller || now < chunk.retryAt) continue;
      chunk.controller = new AbortController();
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
        this.baseUrl,
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
                error: 0,
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
        chunk.retryAt =
          performance.now() +
          Math.min(30_000, 1000 * 2 ** Math.min(chunk.failures++, 5));
        this.failed(error, chunk.file.url);
      }
    } finally {
      decoded?.dispose();
      chunk.controller = undefined;
      // Refill without waiting for update(); defer to avoid recursive failures
      // when a custom loader throws synchronously.
      if (!this.disposed)
        queueMicrotask(() => {
          this.pump(performance.now());
          this.changed();
        });
    }
  }

  private releaseRegion(region: Region) {
    region.batch.releaseRegion(region.start);
    const leaf = this.leaves.get(region.range.leaf);
    if (leaf?.current === region) leaf.current = undefined;
    if (leaf?.outgoing === region) leaf.outgoing = undefined;
  }

  private changed() {
    if (this.disposed) return;
    try {
      this.options.onChange?.();
    } catch (error) {
      console.error("Streamed SOG onChange failed", error);
    }
  }

  private failed(error: unknown, url: string) {
    try {
      if (this.options.onError) this.options.onError(error, url);
      else console.error("Streamed SOG chunk failed", url, error);
    } catch (error) {
      console.error("Streamed SOG onError failed", error);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.rejectFirst(this.abort.signal.reason);
    this.loader.dispose();
    for (const chunk of this.chunks) {
      chunk.controller?.abort();
      chunk.data?.dispose();
      chunk.data = undefined;
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.current) this.releaseRegion(leaf.current);
      if (leaf.outgoing) this.releaseRegion(leaf.outgoing);
      leaf.pending?.data?.dispose();
    }
    this.leaves.clear();
    this.wanted.clear();
    this.chunks = [];
    this.environment = undefined;
    this.manifest = undefined;
    this.visibility = undefined;
  }
}
