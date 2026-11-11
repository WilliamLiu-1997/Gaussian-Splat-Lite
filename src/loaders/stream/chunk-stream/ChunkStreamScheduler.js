import * as THREE from "three";
import {
  sogBatchAllocationSize,
  sogBatchTextureLayout,
} from "../../../data/SogRegionSplats.js";
import { getBlindUploadBytes } from "../../../data/blindData.js";
import { PendingUploads } from "../../../data/pendingUploads.js";
import {
  getSplatByteLength,
  getSplatShDegree,
  getSplatTextureBytes,
} from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamCameras } from "../StreamCameras.js";
import { captureSogView, getSogViewKey } from "../sog-stream/sogVisibility.js";
import {
  checkStreamTransform,
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { ChunkStreamBatch } from "./ChunkStreamBatch.js";
import { ChunkStreamLoader } from "./ChunkStreamLoader.js";
const EMPTY_SELECTION = new Uint32Array(0);
const MAX_REGION_WRITES = 64;
function* retryDeadlines(chunks) {
  for (const chunk of chunks) yield chunk.retryAt;
}
function checkLodBaseDistance(value) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("lodBaseDistance must be finite and positive");
  return value;
}
function checkLodMultiplier(value) {
  if (!Number.isFinite(value) || value < 1)
    throw new Error("lodMultiplier must be finite and at least 1");
  return value;
}
/** Omitted LOD settings follow the scheduler's current defaults. */
function checkSourceLod({ lodBaseDistance, lodMultiplier }) {
  if (lodBaseDistance !== undefined) checkLodBaseDistance(lodBaseDistance);
  if (lodMultiplier !== undefined) checkLodMultiplier(lodMultiplier);
}
function sourceSettings(source) {
  const settings = {
    transform: checkStreamTransform(
      source.transform ?? new THREE.Matrix4(),
    ).clone(),
    environment: source.environment !== false,
    lodBaseDistance: source.lodBaseDistance,
    lodMultiplier: source.lodMultiplier,
  };
  checkSourceLod(settings);
  return settings;
}
/** Shared chunk loading, region uploads, fades and source lifecycle. */
export class ChunkStreamScheduler {
  constructor(options, format) {
    if (options.sources !== undefined)
      throw new Error(
        "Use addSource() to add streaming inputs after construction",
      );
    this.format = format;
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.nodeRanges = new Map();
    this.lastRequestedKey = "";
    this.selecting = false;
    this.refinementStopped = false;
    this.selection = EMPTY_SELECTION;
    this.selectionPending = false;
    this.regionsDirty = true;
    this.releaseAt = Number.POSITIVE_INFINITY;
    this.sources = new Map();
    this.nextSourceId = 0;
    this.chunks = new Map();
    this.environments = [];
    /** Chunks with a batch, cached source or in-flight load. */
    this.activeChunks = new Set();
    this.regions = new Map();
    this.wanted = new Set();
    this.fades = new Map();
    this.shown = true;
    this.disposed = false;
    this.retryTimer = new RetryTimer(() => {
      this.regionsDirty = true;
      this.changed();
    });
    this.options = { onChange: options.onChange, onError: options.onError };
    this.group = new THREE.Group();
    this.uploads = new PendingUploads(this.group);
    const settings = streamSettings(options, 4);
    this._splatBudget = settings.splatBudget;
    this._maxSh = settings.maxSh;
    const blindData = options.blindData ?? true;
    if (typeof blindData !== "boolean")
      throw new Error("blindData must be a boolean");
    this.splatBudgetMode = options.splatBudgetMode ?? "target";
    this.lodBaseDistance = options.lodBaseDistance ?? 100;
    this.lodMultiplier = options.lodMultiplier ?? 2;
    this.lodBehindPenalty = options.lodBehindPenalty ?? 5;
    this.lodDistanceShrink = options.lodDistanceShrink ?? 0;
    this.sourceLodVersion = 0;
    this.cooldownMs = settings.cooldownMs;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.loader = new ChunkStreamLoader(
      this.maxConcurrentLoads,
      this.maxSh,
      () => this.changed(),
      format,
      blindData,
    );
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    // Readiness is optional to observe; failures also go through onError.
    void this.firstRenderable.catch(() => {});
  }
  /** Current source IDs in insertion order, including pending additions. */
  get sourceIds() {
    return [...this.sources.keys()];
  }
  /** Add an independent input; resolves to its stable ID once metadata is ready. */
  addSource(options) {
    this.abort.signal.throwIfAborted();
    if (this.refinementStopped)
      throw new Error("Streaming detail selection has stopped");
    if (this.nextSourceId > 0xffffffff)
      throw new Error("Streaming source ID capacity exceeded");
    const settings = sourceSettings(options);
    const source = {
      id: this.nextSourceId++,
      url: options.url,
      settings,
      controller: new AbortController(),
      chunks: [],
    };
    this.sources.set(source.id, source);
    const ready = this.initializeSource(source, options);
    void ready.catch(() => {});
    return ready;
  }
  /** Remove only this input, canceling its pending work and releasing its data. */
  removeSource(id) {
    const source = this.sources.get(id);
    if (!source) return false;
    this.sources.delete(id);
    source.controller.abort();
    this.loader.removeSource(id);
    const metadata = source.metadata;
    if (metadata) {
      const { nodeBase, parents, environment } = metadata;
      const nodeEnd = nodeBase + parents.length;
      for (const [nodeId, region] of this.regions) {
        if (
          (nodeId < nodeBase || nodeId >= nodeEnd) &&
          (environment < 0 || nodeId !== -1 - environment)
        )
          continue;
        region.pending = undefined;
        if (region.current) this.releaseRegion(region.current);
        this.regions.delete(nodeId);
      }
      for (const nodeId of this.nodeRanges.keys())
        if (nodeId >= nodeBase && nodeId < nodeEnd)
          this.nodeRanges.delete(nodeId);
    }
    for (const chunk of source.chunks) {
      chunk.controller?.abort();
      this.releaseChunkData(chunk);
      this.wanted.delete(chunk);
      this.activeChunks.delete(chunk);
      this.chunks.delete(chunk.index);
    }
    this.selection = this.selection.filter(
      (_, offset, selection) => selection[offset - (offset % 2)] !== id,
    );
    if (!this.selection.length) this.selection = EMPTY_SELECTION;
    this.sourceLodVersion++;
    this.lastRequestedKey = "";
    this.updateEnvironments();
    this.retryTimer.update(retryDeadlines(this.wanted));
    void this.requestSelection();
    this.changed();
    return true;
  }
  /** A source's current settings; IDs are never renumbered or reused. */
  getSourceSettings(id) {
    const settings = this.sourceSetting(id);
    return { ...settings, transform: settings.transform.clone() };
  }
  /** Application-defined JSON from this input's lod-meta.json extras. */
  getSceneExtra(id) {
    const source = this.sources.get(id);
    if (!source) throw new Error(`Unknown Streaming source ID ${id}`);
    return source.metadata?.extra;
  }
  /**
   * Change an input's settings; omitted keys keep their values, and undefined
   * LOD settings follow the scheduler defaults. Loaded data is kept.
   */
  setSourceSettings(id, settings) {
    const source = this.sourceSetting(id);
    // Only LOD settings use undefined to follow the scheduler's values.
    const { transform = source.transform, environment = source.environment } =
      settings;
    const next = { ...source, ...settings, transform, environment };
    checkStreamTransform(next.transform);
    checkSourceLod(next);
    let changed = false;
    if (!source.transform.equals(next.transform)) {
      source.transform.copy(next.transform);
      for (const chunk of this.activeChunks) {
        if (!chunk.batch || chunk.source !== id) continue;
        chunk.batch.matrix.copy(source.transform);
        chunk.batch.matrixWorldNeedsUpdate = true;
      }
      changed = true;
    }
    if (
      source.lodBaseDistance !== next.lodBaseDistance ||
      source.lodMultiplier !== next.lodMultiplier
    ) {
      source.lodBaseDistance = next.lodBaseDistance;
      source.lodMultiplier = next.lodMultiplier;
      // In-flight decisions used the previous bands.
      this.sourceLodVersion++;
      changed = true;
    }
    if (source.environment !== (next.environment !== false)) {
      source.environment = next.environment !== false;
      this.sourceLodVersion++;
      this.updateEnvironments();
      changed = true;
    }
    if (!changed) return;
    // Transforms, like camera motion, only request another decision.
    this.lastRequestedKey = "";
    void this.requestSelection();
    this.changed();
  }
  sourceSetting(id) {
    const source = this.sources.get(id);
    if (!source) throw new Error(`Unknown Streaming source ID ${id}`);
    return source.settings;
  }
  get hasLods() {
    for (const source of this.sources.values())
      if (source.metadata?.hasData) return true;
    return false;
  }
  /** Visible-point budget, including the environment. Reassign to reselect LODs. */
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    if (value === this._splatBudget) return;
    this._splatBudget = positiveInteger(value, "splatBudget");
    void this.requestSelection();
  }
  /** Maximum decoded and stored SH degree (0–4), fixed at construction. */
  get maxSh() {
    return this._maxSh;
  }
  /** Fill the budget, or limit detail to the configured distance bands. */
  get splatBudgetMode() {
    return this._splatBudgetMode;
  }
  set splatBudgetMode(value) {
    if (value === this.splatBudgetMode) return;
    if (value !== "target" && value !== "limit")
      throw new Error('splatBudgetMode must be "target" or "limit"');
    this._splatBudgetMode = value;
    void this.requestSelection();
  }
  /** Default base LOD distance in world units for inputs without their own. */
  get lodBaseDistance() {
    return this._lodBaseDistance;
  }
  set lodBaseDistance(value) {
    if (value === this._lodBaseDistance) return;
    this._lodBaseDistance = checkLodBaseDistance(value);
    void this.requestSelection();
  }
  /** Default distance multiplier between LOD levels, in both budget modes. */
  get lodMultiplier() {
    return this._lodMultiplier;
  }
  set lodMultiplier(value) {
    if (value === this._lodMultiplier) return;
    this._lodMultiplier = checkLodMultiplier(value);
    void this.requestSelection();
  }
  /** Effective distance multiplier directly behind a camera; 1 disables it. */
  get lodBehindPenalty() {
    return this._lodBehindPenalty;
  }
  set lodBehindPenalty(value) {
    if (value === this._lodBehindPenalty) return;
    if (!Number.isFinite(value) || value < 1)
      throw new Error("lodBehindPenalty must be finite and at least 1");
    this._lodBehindPenalty = value;
    void this.requestSelection();
  }
  /** Fraction of excess region size removed when measuring LOD distance. */
  get lodDistanceShrink() {
    return this._lodDistanceShrink;
  }
  set lodDistanceShrink(value) {
    if (value === this._lodDistanceShrink) return;
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error("lodDistanceShrink must be finite and between 0 and 1");
    this._lodDistanceShrink = value;
    void this.requestSelection();
  }
  get stats() {
    const { retainedIndexBytes, ...loaderStats } = this.loader.stats;
    const stats = {
      visibleSplats: 0,
      visibleRegions: 0,
      visibleMeshes: 0,
      residentMeshes: 0,
      residentChunks: 0,
      residentCpuBytes: retainedIndexBytes + this.selection.byteLength,
      residentGpuBytes: 0,
      pendingBytes: 0,
      loadingChunks: 0,
      loadProgress: 1,
      ...loaderStats,
    };
    let pendingSources = 0;
    for (const { metadata } of this.sources.values()) {
      if (!metadata) {
        pendingSources++;
        continue;
      }
      stats.residentCpuBytes +=
        metadata.bounds.byteLength +
        metadata.ranges.byteLength +
        metadata.counts.byteLength +
        metadata.batchStarts.byteLength +
        metadata.batchCapacities.byteLength +
        metadata.parents.byteLength +
        metadata.emptyCoverage.byteLength +
        metadata.roots.byteLength +
        metadata.childOffsets.byteLength +
        metadata.children.byteLength;
    }
    for (const { batch, data, controller } of this.activeChunks) {
      if (batch) {
        stats.residentMeshes++;
        stats.residentCpuBytes += batch.source.getByteLength();
        stats.residentGpuBytes += batch.source.textureByteLength;
        if (this.shown && batch.numSplats > 0) {
          stats.visibleMeshes++;
          stats.visibleSplats += batch.numSplats;
        }
      }
      if (data?.alive) {
        stats.residentChunks++;
        stats.residentCpuBytes += data.info.byteLength;
        if (data.palette && data.palette !== batch?.source.palette) {
          stats.residentCpuBytes += data.palette.byteLength;
          if (data.palette.pendingUploadBytes === 0)
            stats.residentGpuBytes += data.palette.byteLength;
        }
      }
      if (controller) stats.loadingChunks++;
    }
    for (const { current, pending } of this.regions.values()) {
      stats.pendingBytes += pending?.bytes ?? 0;
      if (this.shown && current && Math.fround(current.opacity) > 0)
        stats.visibleRegions++;
    }
    if (this.shown) {
      let targetRegions = this.selection.length / 2 + pendingSources;
      let readyRegions = 0;
      for (let offset = 0; offset < this.selection.length; offset += 2) {
        const source = this.selection[offset];
        const id = this.selection[offset + 1];
        const target = this.nodeRange(source, id);
        if (
          target.count === 0 ||
          this.regions.get(id)?.current?.range === target
        )
          readyRegions++;
      }
      for (const chunk of this.environments) {
        if (chunk.count === 0) continue;
        targetRegions++;
        if (this.regions.get(-1 - chunk.index)?.current) readyRegions++;
      }
      stats.loadProgress =
        this.hasLods && this.selection === EMPTY_SELECTION
          ? 0
          : targetRegions
            ? readyRegions / targetRegions
            : 1;
    }
    stats.residentBytes = stats.residentCpuBytes + stats.residentGpuBytes;
    return stats;
  }
  /** Group-local bounds of inputs whose addSource() metadata is ready. */
  getBoundingBox() {
    const box = new THREE.Box3();
    const bound = new THREE.Box3();
    for (const { metadata, settings } of this.sources.values()) {
      if (!metadata) continue;
      bound.min.fromArray(metadata.bounds);
      bound.max.fromArray(metadata.bounds, 3);
      box.union(bound.applyMatrix4(settings.transform));
    }
    return box;
  }
  async initializeSource(source, options) {
    const { id, controller } = source;
    try {
      const metadata = await this.loader.addSource(
        id,
        options,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      source.metadata = metadata;
      source.chunks = metadata.urls.map((url, local) => {
        const index = metadata.fileBase + local;
        const chunk = {
          url,
          index,
          source: id,
          count: metadata.counts[local],
          environment: index === metadata.environment,
          batchCapacity: metadata.batchCapacities[local],
          failures: 0,
          retryAt: 0,
        };
        this.chunks.set(index, chunk);
        return chunk;
      });
      this.sourceLodVersion++;
      this.lastRequestedKey = "";
      this.updateEnvironments();
      void this.requestSelection();
      this.changed();
      // onChange may remove this source or dispose the scheduler.
      controller.signal.throwIfAborted();
      return id;
    } catch (error) {
      const failed = !controller.signal.aborted && !this.disposed;
      if (failed && this.sources.size === 1) this.rejectFirst(error);
      this.removeSource(id);
      if (failed && !this.refinementStopped) this.failed(error, options.url);
      throw error;
    }
  }
  /** Environment chunks of the inputs that enable theirs. */
  updateEnvironments() {
    this.regionsDirty = true;
    this.environments = [];
    for (const { settings, metadata } of this.sources.values()) {
      if (settings.environment && metadata && metadata.environment >= 0)
        this.environments.push(this.chunks.get(metadata.environment));
    }
    this.resolveIfEmpty();
  }
  resolveIfEmpty() {
    for (const source of this.sources.values()) if (!source.metadata) return;
    if (!this.hasLods && this.environments.every((chunk) => chunk.count === 0))
      this.resolveFirst(this);
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
   * region uses the distance of the nearest registered camera that sees it.
   */
  update() {
    if (this.disposed) return false;
    const cameras = this.streamCameras.seeing(this.group.layers);
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
    if (shown !== this.shown) this.regionsDirty = true;
    this.shown = shown;
    const now = performance.now();
    if (this.refinementStopped) {
      const changed = this.updateFades(now);
      if (this.regionsDirty || now >= this.releaseAt) {
        this.regionsDirty = false;
        this.releaseUnused(now, true);
      }
      if (changed) this.changed();
      return changed;
    }
    if (!shown) {
      this.selection = EMPTY_SELECTION;
      this.lastRequestedKey = "";
    }
    const refresh = this.regionsDirty;
    const selectionPending = this.selectionPending;
    let changed;
    if (refresh) {
      this.regionsDirty = false;
      this.selectionPending = false;
      changed = this.applySelection(this.selectRegions(), now);
      this.updateRequests(now);
    } else changed = this.updateFades(now);
    if (refresh || changed) {
      if (
        shown &&
        [...this.regions.values()].some(({ current }) => current?.opacity > 0)
      )
        this.resolveFirst(this);
      else this.rejectFirstIfUnavailable();
    }
    // Start the new view's decision before retiring caches it may reuse.
    void this.requestSelection();
    // Applied decisions must retire caches even during continuous camera motion.
    const allowRelease = selectionPending || !shown || !this.selecting;
    if (refresh || this.regionsDirty || (allowRelease && now >= this.releaseAt))
      this.releaseUnused(now, allowRelease);
    if (changed) this.changed();
    return changed;
  }
  async requestSelection() {
    const view = this.view;
    if (
      this.disposed ||
      this.refinementStopped ||
      !this.shown ||
      this.selecting ||
      !this.hasLods ||
      !view
    )
      return;
    const splatBudget = this.splatBudget;
    const splatBudgetMode = this.splatBudgetMode;
    const lodBaseDistance = this.lodBaseDistance;
    const lodMultiplier = this.lodMultiplier;
    const lodBehindPenalty = this.lodBehindPenalty;
    const lodDistanceShrink = this.lodDistanceShrink;
    const sourceLodVersion = this.sourceLodVersion;
    const budget = Math.max(
      0,
      splatBudget -
        this.environments.reduce(
          (count, chunk) => count + Math.max(0, chunk.count),
          0,
        ),
    );
    const key = `${getSogViewKey(view)}/${splatBudget}/${budget}/${splatBudgetMode}/${lodBaseDistance}/${lodMultiplier}/${lodBehindPenalty}/${lodDistanceShrink}`;
    if (key === this.lastRequestedKey) return;
    this.lastRequestedKey = key;
    this.selecting = true;
    try {
      const sources = [...this.sources.values()].filter(
        (source) => source.metadata,
      );
      const selection = await this.loader.selectLod({
        view,
        budget,
        splatBudgetMode,
        sources: sources.map(({ id, settings: input }) => ({
          id,
          lodBaseDistance: input.lodBaseDistance ?? lodBaseDistance,
          lodMultiplier: input.lodMultiplier ?? lodMultiplier,
          transform: input.transform.elements,
        })),
        lodBehindPenalty,
        lodDistanceShrink,
      });
      if (
        this.disposed ||
        !this.shown ||
        splatBudget !== this.splatBudget ||
        splatBudgetMode !== this.splatBudgetMode ||
        lodBaseDistance !== this.lodBaseDistance ||
        lodMultiplier !== this.lodMultiplier ||
        sourceLodVersion !== this.sourceLodVersion ||
        lodBehindPenalty !== this.lodBehindPenalty ||
        lodDistanceShrink !== this.lodDistanceShrink
      )
        return;
      // Coalesce results; update() applies the latest one against current caches.
      this.selection = selection;
      this.selectionPending = true;
      this.regionsDirty = true;
      this.changed();
    } catch (error) {
      if (sourceLodVersion === this.sourceLodVersion)
        this.stopRefinement(error);
    } finally {
      this.selecting = false;
    }
  }
  updateRequests(now) {
    for (const chunk of this.activeChunks) {
      if (chunk.controller && !this.wanted.has(chunk)) chunk.controller.abort();
    }
    this.pump(now);
  }
  nodeRange(sourceId, id) {
    let range = this.nodeRanges.get(id);
    if (!range) {
      const metadata = this.sources.get(sourceId).metadata;
      const local = id - metadata.nodeBase;
      const offset = local * 4;
      range = {
        source: sourceId,
        node: id,
        level: metadata.ranges[offset],
        file: metadata.ranges[offset + 1],
        offset: metadata.ranges[offset + 2],
        count: metadata.ranges[offset + 3],
        batchStart: metadata.batchStarts[local],
      };
      this.nodeRanges.set(id, range);
    }
    return range;
  }
  isRangeVisible(range) {
    return !!this.regions.get(range.node)?.target;
  }
  regionState(id) {
    let region = this.regions.get(id);
    if (!region) {
      region = {};
      this.regions.set(id, region);
    }
    return region;
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
    for (const { current } of this.regions.values())
      if (current)
        changed =
          this.fadeRegion(current, this.isRangeVisible(current.range), now) ||
          changed;
    return changed;
  }
  attachPendingRegions(selected, now) {
    let changed = false;
    let written = 0;
    for (const region of selected) {
      const { current, pending, target: range } = region;
      // A region has one range; it is written once and kept until released.
      if (!range || current || pending?.range !== range || !pending.data)
        continue;
      if (written >= MAX_REGION_WRITES) {
        this.regionsDirty = true;
        break;
      }
      const { data, chunk } = pending;
      const start = range.batchStart;
      if (start === undefined) throw new Error("Missing chunk region slot");
      let batch = chunk.batch;
      const palette = batch?.source.palette ?? chunk.data.palette;
      if (palette && !palette.prepareUpload(this.uploads)) {
        this.regionsDirty = true;
        changed = true;
        continue;
      }
      const numSh = getSplatShDegree(data.extra);
      const { capacity, layerSize } = batch
        ? {
            capacity: batch.source.maxSplats,
            layerSize: batch.source.layerSize,
          }
        : sogBatchTextureLayout(chunk.batchCapacity);
      const firstLayer = Math.floor(start / layerSize);
      const lastLayer = Math.ceil(
        (start + sogBatchAllocationSize(range.count)) / layerSize,
      );
      // Charge whole layers; dirty layers already await upload.
      const bytes = batch
        ? batch.source.getUploadBytes(firstLayer, lastLayer)
        : getSplatTextureBytes(
            (lastLayer - firstLayer) * layerSize,
            numSh,
            !!data.extra.shDegree,
          ) +
          getBlindUploadBytes(
            capacity,
            data.extra.blind?.length ?? 0,
            layerSize,
            firstLayer,
            lastLayer,
          );
      // Later regions wait until rendering consumes the queued uploads.
      if (!this.uploads.canAdd(bytes)) {
        this.regionsDirty = true;
        break;
      }
      if (!batch) {
        batch = new ChunkStreamBatch({
          capacity: chunk.batchCapacity,
          numSh,
          group: this.group,
          onEmpty: () => {
            chunk.batch = undefined;
            this.pruneChunk(chunk);
          },
          palette,
          blindFields: data.extra.blind?.map(({ fields }) => fields),
          extra: chunk.data.info.extra,
          sceneExtra: this.getSceneExtra(chunk.source),
        });
        batch.matrixAutoUpdate = false;
        batch.matrix.copy(this.sourceSetting(chunk.source).transform);
        batch.matrixWorldNeedsUpdate = true;
        batch.source.uploadQueue = this.uploads;
        batch.name = chunk.environment
          ? `${this.format}-environment`
          : `${this.format}-chunk-${range.file}`;
        chunk.batch = batch;
        this.activeChunks.add(chunk);
      }
      batch.writeRegion(start, data);
      written++;
      region.pending = undefined;
      region.current = { batch, start, range, opacity: 0 };
      this.fadeRegion(region.current, this.isRangeVisible(range), now);
      this.regionsDirty = true;
      changed = true;
    }
    return changed;
  }
  queueExtractions(selected, now) {
    const batches = new Map();
    for (const region of selected) {
      const range = region.target;
      if (!range || region.current?.range === range || region.pending) continue;
      const chunk = this.chunks.get(range.file);
      const source = chunk.data;
      if (!source?.alive || now < chunk.retryAt) continue;
      const bytes = getSplatTextureBytes(
        range.count,
        source.info.numSh,
        !!source.info.shDegree,
      );
      const pending = {
        range,
        chunk,
        bytes: bytes + range.count * (source.info.blindTextureCount ?? 0) * 4,
      };
      region.pending = pending;
      const batch = batches.get(chunk) ?? { source, regions: [] };
      batch.regions.push(pending);
      batches.set(chunk, batch);
    }
    for (const [chunk, { source, regions }] of batches)
      void this.extract(chunk, source, regions);
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
        this.regionsDirty = true;
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
        const region = this.regions.get(range.node);
        if (region?.pending === pending && region.target === range) {
          pending.data = data;
          pending.bytes = getSplatByteLength(data);
        } else if (region?.pending === pending) region.pending = undefined;
      }
    } catch (error) {
      for (const pending of batch) {
        const region = this.regions.get(pending.range.node);
        if (region?.pending === pending) region.pending = undefined;
      }
      if (
        !this.disposed &&
        !this.refinementStopped &&
        this.chunks.has(chunk.index)
      ) {
        chunk.error = error;
        chunk.retryAt = streamRetryAt(error, chunk.failures++);
        if (!source.alive) {
          source.dispose();
          this.pruneChunk(chunk);
        }
        this.rejectFirstIfUnavailable(error);
        this.failed(error, chunk.url);
      }
    } finally {
      if (!this.disposed) {
        this.regionsDirty = true;
        this.pump(performance.now());
        this.changed();
      }
    }
  }
  releaseUnused(now, allowRelease) {
    this.releaseAt = Number.POSITIVE_INFINITY;
    const referenced = new Set(this.wanted);
    for (const [id, region] of this.regions) {
      const { current, pending } = region;
      if (pending) referenced.add(pending.chunk);
      if (current) {
        if (region.target || current.opacity > 0 || this.fades.has(current)) {
          current.expiresAt = undefined;
          referenced.add(this.chunks.get(current.range.file));
        } else {
          current.expiresAt ??= now + this.cooldownMs;
          if (allowRelease && now >= current.expiresAt)
            this.releaseRegion(current);
          else this.releaseAt = Math.min(this.releaseAt, current.expiresAt);
        }
      }
      if (!region.target && !region.current && !region.pending)
        this.regions.delete(id);
    }
    for (const chunk of this.activeChunks) {
      if (referenced.has(chunk) || chunk.controller || !chunk.data) {
        chunk.expiresAt = undefined;
      } else {
        chunk.expiresAt ??= now + this.cooldownMs;
        if (allowRelease && now >= chunk.expiresAt) {
          this.releaseChunkData(chunk);
          this.pruneChunk(chunk);
        } else this.releaseAt = Math.min(this.releaseAt, chunk.expiresAt);
      }
    }
  }
  pump(now) {
    if (this.disposed || this.refinementStopped) return;
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
        chunk.source,
        chunk.url,
        chunk.count,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (chunk.batch && decoded.info.numSh !== chunk.batch.maxSh)
        throw new Error(
          `Chunk SH degree mismatch: expected ${chunk.batch.maxSh}, received ${decoded.info.numSh}`,
        );
      if (chunk.environment) {
        chunk.count = decoded.info.numSplats;
        chunk.batchCapacity = sogBatchAllocationSize(chunk.count);
        chunk.environmentRange = chunk.count
          ? {
              source: chunk.source,
              node: -1 - chunk.index,
              level: 0,
              file: chunk.index,
              offset: 0,
              count: chunk.count,
              batchStart: 0,
            }
          : undefined;
      } else if (
        this.format === "sog"
          ? decoded.info.numSplats !== chunk.count
          : decoded.info.numSplats < chunk.count
      ) {
        throw new Error(
          `Chunk count mismatch: expected ${chunk.count}, received ${decoded.info.numSplats}`,
        );
      }
      chunk.data = decoded;
      decoded = undefined;
      chunk.expiresAt = undefined;
      chunk.failures = 0;
      chunk.retryAt = 0;
      if (chunk.environment) this.resolveIfEmpty();
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        chunk.error = error;
        chunk.retryAt = streamRetryAt(error, chunk.failures++);
        this.rejectFirstIfUnavailable(error);
        this.failed(error, chunk.url);
      }
    } finally {
      decoded?.dispose();
      chunk.controller = undefined;
      this.pruneChunk(chunk);
      if (!this.disposed) {
        this.regionsDirty = true;
        this.pump(performance.now());
        // Loading the environment changes the budget available to LOD.
        if (chunk.environment) void this.requestSelection();
        this.changed();
      }
    }
  }
  releaseChunkData(chunk) {
    const data = chunk.data;
    if (!data) return;
    this.regionsDirty = true;
    // Pending regions depend on this cache's palette, even after extraction.
    for (const region of this.regions.values())
      if (region.pending?.chunk === chunk) region.pending = undefined;
    // Displayed regions can outlive the worker cache that supplied their palette.
    if (data.palette !== chunk.batch?.source.palette) data.palette?.dispose();
    data.dispose();
    chunk.data = undefined;
  }
  pruneChunk(chunk) {
    if (chunk.data && !chunk.data.alive) this.releaseChunkData(chunk);
    if (!chunk.data) chunk.expiresAt = undefined;
    if (!chunk.batch && !chunk.data && !chunk.controller)
      this.activeChunks.delete(chunk);
  }
  releaseRegion(region) {
    this.regionsDirty = true;
    this.fades.delete(region);
    region.batch.releaseRegion(region.start);
    const state = this.regions.get(region.range.node);
    if (state?.current === region) state.current = undefined;
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, url) {
    notifyStreamError(this.options, error, url);
  }
  rejectFirstIfUnavailable(error) {
    if (this.selecting || (this.hasLods && this.selection === EMPTY_SELECTION))
      return;
    for (const source of this.sources.values()) if (!source.metadata) return;
    // A failed refinement does not invalidate already renderable coverage.
    if (
      [...this.regions.values()].some(
        (region) => region.current || region.pending,
      )
    )
      return;
    const wanted = [...this.wanted].filter((chunk) => chunk.count !== 0);
    if (
      wanted.length &&
      wanted.every((chunk) => chunk.retryAt === Number.POSITIVE_INFINITY)
    )
      this.rejectFirst(error ?? wanted[0].error);
  }
  stopRefinement(error) {
    if (this.disposed || this.refinementStopped) return;
    this.refinementStopped = true;
    this.retryTimer.dispose();
    this.wanted.clear();
    for (const region of this.regions.values()) region.pending = undefined;
    for (const chunk of this.activeChunks) {
      chunk.controller?.abort(error);
      this.releaseChunkData(chunk);
      this.pruneChunk(chunk);
    }
    this.loader.dispose();
    this.rejectFirst(error);
    this.failed(error, this.sources.values().next().value?.url ?? "");
    this.changed();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.retryTimer.dispose();
    this.abort.abort();
    this.rejectFirst(this.abort.signal.reason);
    for (const source of this.sources.values()) source.controller.abort();
    this.loader.dispose();
    for (const chunk of this.activeChunks) {
      chunk.controller?.abort();
      this.releaseChunkData(chunk);
    }
    for (const region of this.regions.values()) {
      if (region.current) this.releaseRegion(region.current);
    }
    this.regions.clear();
    this.fades.clear();
    this.wanted.clear();
    this.chunks.clear();
    this.activeChunks.clear();
    this.environments = [];
    this.sources.clear();
    this.nodeRanges.clear();
    this.view = undefined;
    this.selection = EMPTY_SELECTION;
  }
}
