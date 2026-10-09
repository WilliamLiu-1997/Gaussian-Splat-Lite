import * as THREE from "three";
import { sogBatchAllocationSize } from "../../../data/SogRegionSplats.js";
import {
  getSplatByteLength,
  getSplatShDegree,
  getSplatTextureBytes,
} from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamByteBudget } from "../StreamByteBudget.js";
import { StreamCameras } from "../StreamCameras.js";
import {
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamPendingLimit,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { SogStreamBatch } from "./SogStreamBatch.js";
import { SogStreamLoader } from "./SogStreamLoader.js";
import { SOG_LOD_STRIDE, readSogLodLeaf, resolveSogLod } from "./sogLod.js";
import { captureSogView, getSogViewKey } from "./sogVisibility.js";
const EMPTY_SELECTION = new Uint32Array(0);
function* retryDeadlines(chunks) {
  for (const chunk of chunks) yield chunk.retryAt;
}
/** Camera-driven Streamed SOG loading with per-chunk sources and region fades. */
export class SogStreamScheduler {
  constructor(options) {
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.lodLeaves = new Map();
    this.lastRequestedKey = "";
    this.selecting = false;
    this.selection = EMPTY_SELECTION;
    this.chunks = [];
    /** Chunks with a batch, cached source or in-flight load. */
    this.activeChunks = new Set();
    this.leaves = new Map();
    this.wanted = new Set();
    this.fades = new Map();
    this.shown = true;
    this.disposed = false;
    this.retryTimer = new RetryTimer(() => this.changed());
    this.options = { ...options };
    this.group = options.group ?? new THREE.Group();
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this.cooldownMs = settings.cooldownMs;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
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
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    if (value === this._splatBudget) return;
    this._splatBudget = positiveInteger(value, "splatBudget");
    void this.requestSelection();
  }
  get stats() {
    const { retainedIndexBytes, ...loaderStats } = this.loader.stats;
    const manifest = this.manifest;
    const stats = {
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
  getBoundingBox() {
    const box = new THREE.Box3();
    if (this.manifest) {
      box.min.fromArray(this.manifest.bounds, 0);
      box.max.fromArray(this.manifest.bounds, 3);
    }
    return box;
  }
  async initialize() {
    const manifest = await this.loader.initialize(this.abort.signal);
    this.abort.signal.throwIfAborted();
    this.manifest = manifest;
    const files = manifest.urls.map((url, index) => ({
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
      if (manifest.lods[offset + 3] === 0) continue;
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
  /** Cameras that select detail, in registration order. */
  get cameras() {
    return this.streamCameras.cameras;
  }
  hasCamera(camera) {
    return this.streamCameras.has(camera);
  }
  /**
   * Select detail for this camera on each update. Detail follows distance,
   * so it needs no resolution. For WebXR register renderer.xr.getCamera(): it
   * selects the greatest detail needed by any eye that sees the region. Returns whether the camera was
   * newly added.
   */
  setCamera(camera) {
    return this.streamCameras.add(camera);
  }
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera) {
    return this.streamCameras.delete(camera);
  }
  /**
   * Call before rendering. Returns whether the displayed data changed. Each
   * leaf uses the distance of the nearest registered camera that sees it.
   */
  update() {
    if (this.disposed) return false;
    const cameras = this.streamCameras.seeing(this.group.layers);
    if (!this.manifest) return false;
    for (const chunk of this.activeChunks) {
      this.pruneChunk(chunk);
      if (chunk.batch) chunk.batch.layers.mask = this.group.layers.mask;
    }
    const view = captureSogView(cameras, this.group);
    // Three can register the XR rig before it supplies the first eye poses.
    // Preserve displayed regions and in-flight loads until those poses arrive.
    if (view.shown && !view.cameras.length) return false;
    this.view = view;
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
    // Start the new view's decision before retiring caches it may reuse.
    void this.requestSelection();
    this.releaseUnused(now, !shown || !this.selecting);
    if (
      shown &&
      [...this.leaves.values()].some(
        ({ current, outgoing }) =>
          (current?.opacity ?? 0) > 0 || (outgoing?.opacity ?? 0) > 0,
      )
    )
      this.resolveFirst(this);
    if (changed) this.changed();
    return changed;
  }
  async requestSelection() {
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
    const key = `${getSogViewKey(view)}/${splatBudget}/${budget}`;
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
      // Retire after every accepted decision so motion cannot postpone cleanup.
      this.releaseUnused(now, true);
      this.changed();
    } catch (error) {
      if (!this.disposed) {
        this.rejectFirst(error);
        this.failed(error, this.options.url);
        this.dispose();
      }
    } finally {
      this.selecting = false;
      // Updates replace the latest view while this task runs; no request queue.
      void this.requestSelection();
    }
  }
  updateRequests(refinements, now) {
    // Establish coverage before starting the next LOD request.
    for (const [leaf, chunk] of refinements) {
      if (leaf.current?.range === leaf.target) this.wanted.add(chunk);
    }
    for (const chunk of this.activeChunks) {
      if (chunk.controller && !this.wanted.has(chunk)) chunk.controller.abort();
    }
    this.pump(now);
  }
  selectRegions() {
    for (const leaf of this.leaves.values()) leaf.target = undefined;
    const selected = [];
    this.wanted.clear();
    const show = (range) => {
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
    const refinements = [];
    for (
      let offset = 0;
      this.shown && offset < this.selection.length;
      offset += 2
    ) {
      const id = this.selection[offset];
      let leaf = this.lodLeaves.get(id);
      if (!leaf) {
        leaf = readSogLodLeaf(this.manifest, id);
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
  leafState(id) {
    let leaf = this.leaves.get(id);
    if (!leaf) {
      leaf = {};
      this.leaves.set(id, leaf);
    }
    return leaf;
  }
  chunkFor(range) {
    return range.file < 0 ? this.environment : this.chunks[range.file];
  }
  applySelection(selected, now) {
    // Advance an existing fade before reversing it to avoid opacity jumps.
    let changed = this.updateFades(now);
    changed = this.updateRegionVisibility(now) || changed;
    changed = this.attachPendingRegions(selected, now) || changed;
    this.queueExtractions(selected, now);
    // Complete zero-duration fades in this update as well.
    return this.updateFades(now) || changed;
  }
  updateRegionVisibility(now) {
    let changed = false;
    for (const leaf of this.leaves.values()) {
      const { current, outgoing, target } = leaf;
      if (current) changed = this.fadeRegion(current, !!target, now) || changed;
      if (outgoing) changed = this.fadeRegion(outgoing, false, now) || changed;
    }
    return changed;
  }
  attachPendingRegions(selected, now) {
    let changed = false;
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
      const numSh = getSplatShDegree(data.extra);
      let batch = chunk.batch;
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
  queueExtractions(selected, now) {
    // Bound both in-flight and ready copies by their compact packed byte size.
    // One indivisible oversized region may occupy the queue on its own.
    let pendingBytes = 0;
    for (const leaf of this.leaves.values())
      pendingBytes += leaf.pending?.bytes ?? 0;
    const budget = new StreamByteBudget(
      streamPendingLimit(this.maxConcurrentLoads),
      pendingBytes,
    );
    const batches = new Map();
    for (const leaf of selected) {
      const range = leaf.target;
      if (!range || leaf.current?.range === range || leaf.pending) continue;
      const chunk = this.chunkFor(range);
      const source = chunk.data;
      if (!source?.alive || now < chunk.retryAt) continue;
      const bytes =
        getSplatTextureBytes(range.count, source.info.numSh) + range.count * 4;
      if (!budget.reserve(bytes)) continue;
      const pending = { range, chunk, bytes };
      leaf.pending = pending;
      const batch = batches.get(chunk) ?? { source, regions: [] };
      batch.regions.push(pending);
      batches.set(chunk, batch);
    }
    for (const [chunk, { source, regions }] of batches)
      void this.extract(chunk, source, regions);
  }
  addBatchRange(chunk, offset, count) {
    if (!count || chunk.batchSlots.has(offset)) return;
    chunk.batchSlots.set(offset, chunk.batchCapacity);
    chunk.batchCapacity += sogBatchAllocationSize(count);
  }
  fadeRegion(region, visible, now) {
    const to = visible ? 1 : 0;
    if ((this.fades.get(region)?.to ?? region.opacity) === to) return false;
    this.fades.set(region, { from: region.opacity, to, startedAt: now });
    return true;
  }
  updateFades(now) {
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
  async extract(chunk, source, batch) {
    try {
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
        chunk.retryAt = streamRetryAt(error, chunk.failures++);
        if (!source.alive) {
          source.dispose();
          this.pruneChunk(chunk);
        }
        this.rejectFirstIfUnavailable(error);
        this.failed(error, chunk.file.url);
      }
    } finally {
      if (!this.disposed) {
        this.pump(performance.now());
        this.changed();
      }
    }
  }
  releaseUnused(now, allowRelease) {
    const referenced = new Set(this.wanted);
    for (const [id, leaf] of this.leaves) {
      const { current, outgoing, pending } = leaf;
      if (pending) referenced.add(pending.chunk);
      if (outgoing) referenced.add(this.chunkFor(outgoing.range));
      if (current) {
        if (
          leaf.target ||
          current.opacity > 0 ||
          this.fades.has(current) ||
          outgoing
        ) {
          current.expiresAt = undefined;
          referenced.add(this.chunkFor(current.range));
        } else {
          current.expiresAt ??= now + this.cooldownMs;
          if (allowRelease && now >= current.expiresAt)
            this.releaseRegion(current);
        }
      }
      if (!leaf.target && !leaf.current && !leaf.outgoing && !leaf.pending)
        this.leaves.delete(id);
    }
    for (const chunk of this.activeChunks) {
      if (referenced.has(chunk) || chunk.controller || !chunk.data) {
        chunk.expiresAt = undefined;
      } else {
        chunk.expiresAt ??= now + this.cooldownMs;
        if (allowRelease && now >= chunk.expiresAt) {
          chunk.data.dispose();
          this.pruneChunk(chunk);
        }
      }
    }
  }
  pump(now) {
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
    this.retryTimer.update(retryDeadlines(this.wanted));
  }
  async load(chunk, controller) {
    let decoded;
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
        chunk.retryAt = streamRetryAt(error, chunk.failures++);
        this.rejectFirstIfUnavailable(error);
        this.failed(error, chunk.file.url);
      }
    } finally {
      decoded?.dispose();
      chunk.controller = undefined;
      this.pruneChunk(chunk);
      if (!this.disposed) {
        this.pump(performance.now());
        // Loading the environment changes the budget available to LOD.
        if (chunk === this.environment) void this.requestSelection();
        this.changed();
      }
    }
  }
  pruneChunk(chunk) {
    if (chunk.data && !chunk.data.alive) chunk.data = undefined;
    if (!chunk.data) chunk.expiresAt = undefined;
    if (!chunk.batch && !chunk.data && !chunk.controller)
      this.activeChunks.delete(chunk);
  }
  releaseRegion(region) {
    this.fades.delete(region);
    region.batch.releaseRegion(region.start);
    const leaf = this.leaves.get(region.range.leaf);
    if (leaf?.current === region) leaf.current = undefined;
    if (leaf?.outgoing === region) leaf.outgoing = undefined;
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, url) {
    notifyStreamError(this.options, error, url);
  }
  rejectFirstIfUnavailable(error) {
    // A failed refinement does not invalidate already renderable coverage.
    if ([...this.leaves.values()].some((leaf) => leaf.current || leaf.pending))
      return;
    if (
      this.wanted.size > 0 &&
      [...this.wanted].every(
        (chunk) => chunk.retryAt === Number.POSITIVE_INFINITY,
      )
    )
      this.rejectFirst(error);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.retryTimer.dispose();
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
