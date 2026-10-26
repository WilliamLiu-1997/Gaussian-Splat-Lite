import * as THREE from "three";
import { RAD_PAGE_SIZE } from "../../../data/defines.js";
import { PendingUploads } from "../../../data/pendingUploads.js";
import { getSplatByteLength } from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamCameras, streamViews } from "../StreamCameras.js";
import {
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { RadStreamBatch } from "./RadStreamBatch.js";
import { RadStreamLoader } from "./RadStreamLoader.js";
import { radChunkIndex, radPageCosts } from "./radLod.js";
function pendingPageBytes(page) {
  // Registration copies are charged separately once decoding completes.
  if (page.storage?.phase === "decoded")
    return getSplatByteLength(page.storage.data);
  return page.load ? page.source.pendingBytes : 0;
}
function budgetTolerance(value) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("splatBudgetTolerance must be finite and nonnegative");
  return value;
}
/** Camera-driven RAD tree cuts with crossfades, on-demand pages and cooldown. */
export class RadStreamScheduler {
  constructor(options) {
    this.options = options;
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.pages = new Map();
    this.pools = [];
    this.bounds = new THREE.Box3();
    this.matrix = new THREE.Matrix4();
    this.sources = [];
    this.pageBudget = 0;
    this.rootPages = new Set();
    this.disposed = false;
    this.shown = true;
    this.wanted = new Set();
    this.revision = 0;
    this.lastRequestedRevision = -1;
    this.refinementStopped = false;
    this.lastViewKey = "";
    this.views = [];
    this.lodTimeMs = 0;
    this.retryTimer = new RetryTimer(() => this.changed());
    this.group = new THREE.Group();
    this.uploads = new PendingUploads(this.group);
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this._maxSh = settings.maxSh;
    this._splatBudgetTolerance = budgetTolerance(
      options.splatBudgetTolerance ?? 0.1,
    );
    this.cooldownMs = settings.cooldownMs;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.maxResidentCpuBytes = positiveInteger(
      options.maxResidentCpuBytes ?? 2 * 1024 * 1024 * 1024,
      "maxResidentCpuBytes",
    );
    this.maxResidentGpuBytes = positiveInteger(
      options.maxResidentGpuBytes ?? 1024 * 1024 * 1024,
      "maxResidentGpuBytes",
    );
    this.loader = new RadStreamLoader(
      options,
      this.maxConcurrentLoads,
      this.maxSh,
      () => this.changed(),
    );
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.initialized = this.initialize().catch((error) => {
      this.rejectFirst(error);
      this.dispose();
      throw error;
    });
    void this.initialized.catch(() => {});
    void this.firstRenderable.catch(() => {});
  }
  /** Target selected-node budget. Assigning a new value requests LOD selection. */
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    if (value === this._splatBudget) return;
    positiveInteger(value, "splatBudget");
    if (value < this.rootPages.size)
      throw new Error("splatBudget must cover every RAD input root");
    this._splatBudget = value;
    this.invalidatePendingSelection();
    this.revision++;
    void this.requestSelection();
  }
  /** Maximum decoded and stored SH degree (0–3), fixed at construction. */
  get maxSh() {
    return this._maxSh;
  }
  /** Allowed fractional budget overshoot; zero forbids overshoot. */
  get splatBudgetTolerance() {
    return this._splatBudgetTolerance;
  }
  set splatBudgetTolerance(value) {
    if (value === this._splatBudgetTolerance) return;
    this._splatBudgetTolerance = budgetTolerance(value);
    this.invalidatePendingSelection();
    this.revision++;
    void this.requestSelection();
  }
  /** Cameras that select detail, in registration order. */
  get cameras() {
    return this.streamCameras.cameras;
  }
  hasCamera(camera) {
    return this.streamCameras.has(camera);
  }
  /**
   * Select detail for this camera on each update; set its resolution too. For
   * WebXR register renderer.xr.getCamera(): it selects with its eyes' combined
   * frustum, sized by an eye's viewport. Returns whether the camera was newly
   * added.
   */
  setCamera(camera) {
    return this.streamCameras.add(camera);
  }
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera) {
    return this.streamCameras.delete(camera);
  }
  /**
   * Set a registered camera's render size in CSS pixels, without the device
   * pixel ratio. Returns whether the camera is registered.
   */
  setResolution(camera, xOrVec, y) {
    return this.streamCameras.setResolution(camera, xOrVec, y);
  }
  /** Set a registered camera's resolution from renderer.getSize(). */
  setResolutionFromRenderer(camera, renderer) {
    return this.streamCameras.setResolutionFromRenderer(camera, renderer);
  }
  get stats() {
    const loader = this.loader.stats;
    const ready = this.ready?.selection;
    const stats = {
      visibleSplats: 0,
      visibleMeshes: 0,
      residentChunks: 0,
      residentMeshes: this.pools.length,
      residentCpuBytes:
        loader.estimatedCodebookBytes +
        loader.codebookCacheBytes +
        loader.cachedBytes +
        loader.selectionBytes +
        (this.displayed?.selection.indices.byteLength ?? 0),
      residentGpuBytes: 0,
      pendingBytes:
        this.loader.pendingRegistrationBytes +
        (this.preparation?.bytes ?? 0) +
        (ready?.indices.byteLength ?? 0) +
        (ready?.fade?.indices.byteLength ?? 0) +
        (ready?.fade?.fades.byteLength ?? 0),
      loadingChunks: 0,
      loadProgress: 0,
      downloadedBytes: loader.downloadedBytes,
      peakWasmMemoryBytes: loader.peakWasmMemoryBytes,
      pageBudget: this.pageBudget,
      lodTimeMs: this.lodTimeMs,
    };
    for (const { batch } of this.pools) {
      stats.residentCpuBytes += batch.source.getByteLength();
      stats.residentGpuBytes += batch.source.textureByteLength;
      if (this.shown && batch.numSplats > 0) {
        stats.visibleSplats += batch.numSplats;
        stats.visibleMeshes++;
      }
    }
    let readyPages = 0;
    for (const page of this.pages.values()) {
      if (!this.refinementStopped && page.storage && !page.registration) {
        // Retained centers, radii, child ranges and two traversal bitsets.
        stats.residentCpuBytes +=
          page.count * 22 + Math.ceil(page.count / 64) * 16;
      }
      if (page.storage?.phase === "resident") {
        stats.residentChunks++;
        if (
          this.wanted.has(page.index) &&
          this.displayed?.pages.has(page.index)
        )
          readyPages++;
      }
      if (page.load) stats.loadingChunks++;
      stats.pendingBytes += pendingPageBytes(page);
    }
    if (this.meta) {
      stats.loadProgress =
        !this.shown || !this.meta.count
          ? 1
          : this.wanted.size
            ? readyPages / this.wanted.size
            : Number(!!this.displayed && !this.refinementStopped);
    }
    stats.residentBytes = stats.residentCpuBytes + stats.residentGpuBytes;
    return stats;
  }
  /** Group-local root bounds plus selected Gaussian extents; approximate while streaming. */
  getBoundingBox() {
    const box = this.bounds.clone();
    // Coarse centers can cluster inside large Gaussians. Include their extent
    // here so callers can frame the scene without inspecting owned batches.
    for (const { batch } of this.pools) {
      if (!batch.numSplats) continue;
      if (batch.matrixAutoUpdate) batch.updateMatrix();
      box.union(batch.getBoundingBox(false).applyMatrix4(batch.matrix));
    }
    return box;
  }
  async initialize() {
    const { meta, roots, headers } = await this.loader.initialize(
      this.abort.signal,
    );
    this.abort.signal.throwIfAborted();
    if (meta.count && !meta.lodTree) {
      const error = new Error(
        "RAD streaming requires a LOD tree; load this file with SplatMesh instead",
      );
      error.name = "RadLodRequiredError";
      throw error;
    }
    this.meta = meta;
    this.sources = headers.map(({ meta }) => {
      const numSh = Math.min(meta.maxSh ?? 0, this.maxSh);
      return { numSh, pendingBytes: radPageCosts(numSh).pending };
    });
    this.rootPages = new Set(roots);
    if (!meta.count) {
      this.resolveFirst(this);
      this.changed();
      return this;
    }
    for (let index = 0; index < meta.chunks.length; index++)
      if (meta.chunks[index].count > RAD_PAGE_SIZE)
        throw new Error(
          `RAD streaming chunk ${index} exceeds the 65,536-splat page limit`,
        );
    if (this.splatBudget < roots.length)
      throw new Error("splatBudget must cover every RAD input root");
    const pageCosts = radPageCosts(meta.maxSh);
    const cpuOverheadBytes = this.loader.residentCpuOverheadBytes;
    const availableCpuBytes = this.maxResidentCpuBytes - cpuOverheadBytes;
    const cpu = roots.length * pageCosts.cpu;
    const gpu = roots.length * pageCosts.gpu;
    if (availableCpuBytes < cpu)
      throw new Error(
        `RAD maxResidentCpuBytes must be at least ${cpuOverheadBytes + cpu} bytes for these inputs`,
      );
    if (this.maxResidentGpuBytes < gpu)
      throw new Error(
        `RAD maxResidentGpuBytes must be at least ${gpu} bytes for these inputs`,
      );
    // All slots have the same SH storage; allocation and traversal share this cap.
    this.pageBudget = Math.min(
      meta.chunks.length,
      Math.floor(availableCpuBytes / pageCosts.cpu),
      Math.floor(this.maxResidentGpuBytes / pageCosts.gpu),
    );
    this.wanted = new Set(roots);
    this.pump();
    this.changed();
    return this;
  }
  /**
   * Call before rendering. Registered cameras share one cut at the greatest
   * detail any of them needs.
   */
  update() {
    if (this.disposed) return false;
    const cameras = this.streamCameras.seeing(this.group.layers);
    if (!this.meta) return false;
    const now = performance.now();
    if (this.refinementStopped) {
      for (const { batch } of this.pools)
        batch.layers.mask = this.group.layers.mask;
      let changed = this.updateFade(now);
      changed = this.releaseUnused(now, true) || changed;
      if (changed) this.changed();
      return changed;
    }
    this.group.updateWorldMatrix(true, false);
    let shown = cameras.length > 0;
    for (let object = this.group; object; object = object.parent)
      shown &&= object.visible;
    let changed = false;
    if (shown !== this.shown) {
      this.shown = shown;
      this.revision++;
      if (!shown) {
        this.clearSelectionState();
        for (const { batch } of this.pools)
          changed = batch.clearSelection() || changed;
        this.cancelUnusedLoads();
      }
    }
    for (const { batch } of this.pools)
      batch.layers.mask = this.group.layers.mask;
    this.views = [];
    for (const camera of streamViews(cameras)) {
      // A WebXR camera is sized by an eye's viewport: a headset has only
      // physical pixels.
      const viewport = camera.viewport;
      const resolution = this.streamCameras.getResolution(camera);
      const width = viewport?.z ?? resolution?.x;
      const height = viewport?.w ?? resolution?.y;
      if (width === undefined || height === undefined)
        throw new Error(
          "RAD camera has no resolution; call setResolution() or setResolutionFromRenderer()",
        );
      this.matrix
        .copy(camera.matrixWorld)
        .invert()
        .multiply(this.group.matrixWorld);
      const p = camera.projectionMatrix.elements;
      this.views.push({
        viewFromObject: this.matrix.elements.slice(),
        projectionRows: [p[0], p[4], p[8], p[12], p[1], p[5], p[9], p[13]],
        pixelScale:
          Math.max(Math.abs(p[0]) * width, Math.abs(p[5]) * height) / 2,
        orthographic: camera.isOrthographicCamera === true,
      });
    }
    const key = this.views
      .map(
        (view) =>
          `${view.viewFromObject.join(",")}/${view.projectionRows.join(",")}/${view.pixelScale}/${view.orthographic}`,
      )
      .join(";");
    if (key !== this.lastViewKey) {
      this.lastViewKey = key;
      this.revision++;
    }
    if (shown)
      for (const index of this.rootPages)
        if (!this.pages.get(index)?.storage?.allocation) this.wanted.add(index);
    changed = this.updateFade(now) || changed;
    if (shown) {
      this.reservePages();
      changed = this.uploadPages() || changed;
    }
    const preparation = this.preparation;
    if (preparation?.result && !this.displayed?.transition) {
      this.preparation = undefined;
      if (!preparation.cancelled && shown)
        changed =
          this.applySelection(preparation.result, preparation.pools, now) ||
          changed;
    }
    // Keep drawing the old cut until its replacement is prepared.
    if (
      this.ready &&
      !this.preparation &&
      !this.displayed?.transition &&
      this.selectionPagesReady(this.ready.selection)
    ) {
      const { selection: selected, reselect } = this.ready;
      this.ready = undefined;
      if (selected.changedChunks.length) void this.prepareSelection(selected);
      else
        changed =
          this.applySelection(
            { selection: selected, fade: false, pools: [] },
            [],
            now,
          ) || changed;
      if (reselect) this.revision++;
    }
    // Keep expired caches until a pending view/budget decision can reuse them.
    const allowRelease = !shown || this.lastRequestedRevision === this.revision;
    changed = this.releaseUnused(now, allowRelease) || changed;
    if (shown) {
      void this.requestSelection();
      this.pump();
    }
    if (changed) this.changed();
    return changed;
  }
  get selectionBaselineId() {
    return this.preparation && !this.preparation.cancelled
      ? this.preparation.selectionId
      : (this.displayed?.selection.selectionId ?? 0);
  }
  async requestSelection() {
    if (
      this.disposed ||
      this.refinementStopped ||
      !this.shown ||
      this.traversal ||
      !this.meta?.count ||
      !this.views.length ||
      this.lastRequestedRevision === this.revision
    )
      return;
    const residentChunks = [];
    const traversal = new Set();
    for (const pool of this.pools) {
      for (const page of pool.slots) {
        if (!page) continue;
        traversal.add(page.index);
        if (!page.registration) residentChunks.push(page.index);
      }
    }
    if (!residentChunks.some((index) => this.rootPages.has(index))) return;
    const previousId = this.selectionBaselineId;
    const splatBudget = this.splatBudget;
    const splatBudgetTolerance = this.splatBudgetTolerance;
    this.traversal = traversal;
    this.lastRequestedRevision = this.revision;
    const started = performance.now();
    let accepted = false;
    try {
      const selection = await this.loader.selectLod({
        views: this.views,
        splatBudget,
        splatBudgetTolerance,
        pageBudget: this.pageBudget,
        pixelThreshold: 1,
        residentChunks,
        previousId,
        displayedId: this.displayed?.selection.selectionId,
        readyId: this.ready?.selection.selectionId,
        fade: this.fadeDurationMs > 0,
      });
      if (
        this.disposed ||
        !this.shown ||
        splatBudget !== this.splatBudget ||
        splatBudgetTolerance !== this.splatBudgetTolerance
      )
        return;
      this.lodTimeMs = performance.now() - started;
      // Keep the selected tree path while its reserved pages await writing.
      this.wanted = new Set(selection.wantedChunks);
      for (const index of selection.touchedChunks) this.wanted.add(index);
      const now = performance.now();
      for (const index of this.wanted) {
        const page = this.pages.get(index);
        if (page) page.lastUsed = now;
      }
      accepted = true;
      this.cancelUnusedLoads();
      this.pump();
      // Publishing the prepared cut preserves this baseline. Starting or
      // cancelling preparation changes it and requires a fresh fade decision.
      if (this.selectionBaselineId !== previousId) {
        this.lastRequestedRevision = -1;
        this.changed();
        return;
      }
      if (
        this.ready &&
        !this.displayed?.transition &&
        !this.selectionPagesReady(selection)
      ) {
        // Finish the waiting cut instead of chasing newly decoded pages forever.
        // Loading still follows the latest result; refresh after publication.
        this.ready.reselect = true;
      } else {
        this.ready = {
          selection,
          pages: new Set(selection.touchedChunks),
          reselect: false,
        };
      }
      this.changed();
    } catch (error) {
      this.stopRefinement(error);
    } finally {
      this.traversal = undefined;
      // Each accepted decision retires unused caches before the next snapshot,
      // even if the camera kept moving while the worker was selecting.
      if (!this.disposed) {
        const revision = this.revision;
        this.cancelUnusedLoads();
        // Reuse retired slots before another traversal pins its snapshot.
        this.reservePages();
        const released = this.releaseUnused(
          performance.now(),
          accepted || !this.shown,
        );
        if (released || revision !== this.revision) {
          this.changed();
          this.pump();
        }
      }
      // Updates overwrite views/revision while this task runs. Dispatch their
      // latest snapshot immediately; ready results never block the next task.
      void this.requestSelection();
    }
  }
  selectionPagesReady(selection) {
    // Shared and outgoing nodes are already displayed; only changed pages may
    // still be unwritten. Ancestors need not delay publishing the selected cut.
    return selection.changedChunks.every((index) => {
      const page = this.pages.get(index);
      return page?.storage?.phase === "resident";
    });
  }
  async prepareSelection(selection) {
    let preparation;
    try {
      const rangesByPool = new Map();
      for (const index of selection.changedChunks) {
        const pool = this.pages.get(index)?.storage?.allocation?.pool;
        if (!pool) throw new Error("RAD transition references a retired page");
        if (!rangesByPool.has(pool)) rangesByPool.set(pool, []);
      }
      const indices = selection.fade?.indices ?? selection.indices;
      const meta = this.meta;
      let selectedCount = 0;
      // Sorted file indices let us resolve each page once, without a per-node
      // scan on the main thread. Only changed pools need replacement data.
      for (let start = 0; start < indices.length; ) {
        const page = this.pages.get(radChunkIndex(meta, indices[start]));
        const allocation = page?.storage?.allocation;
        if (!page || !allocation)
          throw new Error("RAD cut references a retired page");
        const { pool, slot } = allocation;
        const pageEnd = page.base + page.count;
        let end = start + 1;
        let high = indices.length;
        while (end < high) {
          const middle = Math.floor((end + high) / 2);
          if (indices[middle] < pageEnd) end = middle + 1;
          else high = middle;
        }
        const ranges = rangesByPool.get(pool);
        if (ranges) {
          ranges.push({
            start,
            end,
            slot,
            chunkIndex: page.index,
            sourceBase: page.base,
          });
          selectedCount += end - start;
        }
        start = end;
      }
      const pools = Array.from(rangesByPool, ([pool, ranges]) =>
        pool.batch.source.snapshotSelection(ranges),
      );
      // Pin physical slots until the reply, even when cancelled or hidden.
      const pages = new Set();
      for (const page of this.pages.values())
        if (page.storage?.allocation) pages.add(page.index);
      preparation = {
        selectionId: selection.selectionId,
        // Same order as the worker's pool snapshots and results.
        pools: Array.from(rangesByPool.keys()),
        pages,
        cancelled: false,
        bytes:
          selection.indices.byteLength +
          (selection.fade?.indices.byteLength ?? 0) +
          (selection.fade?.fades.byteLength ?? 0) +
          selection.changedChunks.byteLength +
          selection.touchedChunks.byteLength +
          selection.wantedChunks.byteLength +
          selectedCount * 8 + // Render indices and post-fade indices.
          // Opacity tables, selection bits, page counts, bounds and dirty flags.
          pools.reduce(
            (bytes, pool) =>
              bytes +
              pool.opacityBlocks.byteLength +
              pool.opacityBlocks.length * 2 + // One selection bit per source.
              pool.pageCount * 9 +
              96,
            0,
          ),
      };
      this.preparation = preparation;
      const result = await this.loader.prepareSelection({ selection, pools });
      if (this.preparation !== preparation) return;
      preparation.result = result;
    } catch (error) {
      if (this.disposed || this.preparation !== preparation) return;
      this.preparation = undefined;
      this.lastRequestedRevision = -1;
      if (!preparation?.cancelled) {
        this.stopRefinement(error);
      }
    }
    this.changed();
  }
  applySelection(prepared, affected, now) {
    const { selection, fade } = prepared;
    let index = 0;
    for (const pool of affected) {
      pool.batch.commitSelection(prepared.pools[index++]);
      if (pool.batch.numSplats > 0 && pool.batch.parent !== this.group)
        this.group.add(pool.batch);
      else if (pool.batch.numSplats === 0) pool.batch.removeFromParent();
    }
    this.displayed = {
      selection,
      pages: new Set(selection.touchedChunks),
      transition: fade ? { startedAt: now, pools: affected } : undefined,
    };
    this.cancelUnusedLoads();
    if (selection.indices.length && !fade) this.resolveFirst(this);
    return affected.length > 0;
  }
  invalidatePendingSelection() {
    this.ready = undefined;
    // A cancelled preparation still owns its physical slots until the reply.
    if (this.preparation) this.preparation.cancelled = true;
  }
  clearSelectionState() {
    this.invalidatePendingSelection();
    this.displayed = undefined;
    this.wanted.clear();
  }
  /** Worker snapshots and waiting cuts pin pages without renewing cooldown. */
  isPagePinned(index) {
    return (
      this.traversal?.has(index) ||
      this.ready?.pages.has(index) ||
      this.preparation?.pages.has(index)
    );
  }
  cancelUnusedLoads() {
    for (const page of this.pages.values()) {
      if (
        !this.wanted.has(page.index) &&
        !this.isPagePinned(page.index) &&
        !this.rootPages.has(page.index)
      ) {
        page.load?.abort();
        if (page.storage?.phase === "decoded") this.releasePage(page);
      }
    }
  }
  updateFade(now) {
    const displayed = this.displayed;
    const transition = displayed?.transition;
    if (!displayed || !transition) return false;
    const progress = THREE.MathUtils.clamp(
      (now - transition.startedAt) / this.fadeDurationMs,
      0,
      1,
    );
    if (progress > 0 && displayed.selection.indices.length)
      this.resolveFirst(this);
    if (progress === 1) {
      displayed.transition = undefined;
      let changed = false;
      for (const { batch } of transition.pools) {
        changed = batch.finishFade() || changed;
        if (batch.numSplats === 0) batch.removeFromParent();
      }
      return changed;
    }
    let changed = false;
    for (const { batch } of transition.pools)
      if (batch.numSplats > 0)
        changed = batch.setFadeProgress(progress) || changed;
    return changed;
  }
  page(index) {
    let page = this.pages.get(index);
    if (!page) {
      const { base, count, source } = this.meta.chunks[index];
      page = {
        index,
        base,
        count,
        source: this.sources[source],
        failures: 0,
        retryAt: 0,
        lastUsed: performance.now(),
      };
      this.pages.set(index, page);
    }
    return page;
  }
  pump() {
    if (this.disposed || this.refinementStopped || !this.meta) return;
    let loading = 0;
    for (const page of this.pages.values()) if (page.load) loading++;
    const now = performance.now();
    for (const index of this.wanted) {
      const page = this.page(index);
      if (page.storage || page.load || now < page.retryAt) continue;
      if (loading >= this.maxConcurrentLoads) break;
      const load = new AbortController();
      page.load = load;
      loading++;
      void this.loadPage(page, load);
    }
  }
  async loadPage(page, load) {
    const { signal } = load;
    let registration;
    const active = () =>
      !this.disposed &&
      !this.refinementStopped &&
      !signal.aborted &&
      (page.load === load ||
        (registration && page.registration === registration));
    try {
      let result = await this.loader.loadChunk(page.index, signal);
      if (!active()) {
        this.loader.releaseChunk(page.index);
        return;
      }
      registration = result.registration;
      page.registration = registration;
      // Decoded buffers stay owned here until written to the reserved slot.
      page.storage = { phase: "decoded", data: result.data };
      if (this.rootPages.has(page.index)) this.setInitialBounds(result.data);
      // Uploads can release these buffers while registration is still pending.
      result = undefined;
      this.reservePages();
      // Registration must not occupy a decoder slot or delay page uploads.
      page.load = undefined;
      this.pump();
      this.changed();
      await registration;
      if (!active()) return;
      page.registration = undefined;
      page.failures = 0;
      this.revision++;
    } catch (error) {
      if (active()) {
        if (this.loader.selectionWorkerLost) return this.stopRefinement(error);
        if (registration) this.releasePage(page);
        page.retryAt = streamRetryAt(error, page.failures++);
        if (
          [...this.rootPages].every(
            (index) =>
              this.pages.get(index)?.retryAt === Number.POSITIVE_INFINITY,
          )
        )
          this.rejectFirst(error);
        this.failed(error, page.index);
      }
    } finally {
      if (page.load === load) page.load = undefined;
      this.scheduleRetry();
      if (!this.disposed) {
        void this.requestSelection();
        this.changed();
        this.pump();
      }
    }
  }
  setInitialBounds(data) {
    // The page worker computes these bounds during Morton reordering.
    const bounds = data.centerOnlyBoundingBox;
    const box = new THREE.Box3();
    box.min.fromArray(bounds);
    box.max.fromArray(bounds, 3);
    // The root-page radius covers initial bounds that collapse to one point.
    if (box.min.equals(box.max))
      box.expandByScalar(Math.max(0.001, data.rootRadius));
    this.bounds.union(box);
  }
  findSlot() {
    let capacity = 0;
    let oldest;
    for (const pool of this.pools) {
      capacity += pool.slots.length;
      for (const [slot, page] of pool.slots.entries()) {
        if (!page) return { pool, slot };
        if (this.isPageRequired(page) || this.isPagePinned(page.index))
          continue;
        if (!oldest || page.lastUsed < oldest.lastUsed) oldest = page;
      }
    }
    let missing = 0;
    for (const index of this.wanted)
      if (!this.pages.get(index)?.storage?.allocation) missing++;
    const count = Math.min(8, missing, this.pageBudget - capacity);
    if (count > 0) {
      const batch = new RadStreamBatch({
        pageCount: count,
        numSh: this.meta.maxSh,
      });
      batch.source.uploadQueue = this.uploads;
      batch.layers.mask = this.group.layers.mask;
      const pool = { batch, slots: Array(count).fill(undefined) };
      this.pools.push(pool);
      return { pool, slot: 0 };
    }
    if (oldest) {
      const allocation = oldest.storage.allocation;
      // Memory pressure takes precedence over the idle-cache cooldown.
      this.releasePage(oldest);
      return allocation;
    }
  }
  reservePages() {
    // Missing pages are ordered by the LOD traversal's refinement priority.
    for (const index of this.wanted) {
      const page = this.pages.get(index);
      const storage = page?.storage;
      if (storage?.phase !== "decoded" || storage.allocation) continue;
      const available = this.findSlot();
      if (!available) break;
      const { pool, slot } = available;
      pool.slots[slot] = page;
      storage.allocation = available;
      if (!page.registration) this.revision++;
    }
  }
  uploadPages() {
    let changed = false;
    const pages = new Set([...(this.ready?.pages ?? []), ...this.wanted]);
    for (const index of pages) {
      const page = this.pages.get(index);
      const storage = page?.storage;
      if (!page || storage?.phase !== "decoded" || !storage.allocation)
        continue;
      const { pool, slot } = storage.allocation;
      const bytes = pool.batch.source.getUploadBytes(slot, slot + 1);
      if (!this.uploads.canAdd(bytes)) break;
      pool.batch.source.writePage(slot, storage.data, page.source.numSh);
      page.storage = { phase: "resident", allocation: storage.allocation };
      page.expiresAt = undefined;
      changed = true;
    }
    return changed;
  }
  releasePage(page) {
    const allocation = page.storage?.allocation;
    if (allocation) {
      const { pool, slot } = allocation;
      pool.slots[slot] = undefined;
    }
    page.storage = undefined;
    page.registration = undefined;
    page.expiresAt = undefined;
    this.loader.releaseChunk(page.index);
    this.revision++;
  }
  isPageRequired(page) {
    const allocation = page.storage?.allocation;
    return (
      this.rootPages.has(page.index) ||
      this.displayed?.pages.has(page.index) ||
      this.wanted.has(page.index) ||
      allocation?.pool.batch.source.isPageSelected(allocation.slot)
    );
  }
  releaseUnused(now, allowRelease) {
    let changed = false;
    for (const page of this.pages.values()) {
      if (!page.storage?.allocation) continue;
      if (this.isPageRequired(page)) {
        page.expiresAt = undefined;
        continue;
      }
      page.expiresAt ??= now + this.cooldownMs;
      // A traversal snapshot delays release without renewing unused pages.
      if (
        !allowRelease ||
        now < page.expiresAt ||
        this.isPagePinned(page.index)
      )
        continue;
      this.releasePage(page);
      changed = true;
    }
    for (let index = this.pools.length - 1; index >= 0; index--) {
      const pool = this.pools[index];
      if (pool.slots.every((page) => page === undefined)) {
        pool.batch.dispose();
        this.pools.splice(index, 1);
        changed = true;
      }
    }
    return changed;
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, index) {
    notifyStreamError(this.options, error, this.loader.getChunkUrl(index));
  }
  stopRefinement(error) {
    if (this.disposed || this.refinementStopped) return;
    this.refinementStopped = true;
    this.ready = undefined;
    this.preparation = undefined;
    this.wanted.clear();
    this.retryTimer.dispose();
    for (const page of this.pages.values()) page.load?.abort(error);
    this.loader.dispose();
    for (const page of this.pages.values())
      if (page.storage?.phase === "decoded") this.releasePage(page);
    this.rejectFirst(error);
    this.failed(error, -1);
    this.changed();
  }
  scheduleRetry() {
    if (!this.refinementStopped) this.retryTimer.update(this.retryDeadlines());
  }
  *retryDeadlines() {
    for (const index of this.wanted) {
      const page = this.pages.get(index);
      if (page && !page.storage) yield page.retryAt;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.retryTimer.dispose();
    const reason = new DOMException("RAD scheduler disposed", "AbortError");
    this.abort.abort(reason);
    this.rejectFirst(reason);
    for (const page of this.pages.values()) page.load?.abort(reason);
    this.loader.dispose();
    this.preparation = undefined;
    for (const { batch } of this.pools) batch.dispose();
    this.pools.length = 0;
    this.pages.clear();
    this.clearSelectionState();
    this.traversal = undefined;
    this.meta = undefined;
    this.bounds.makeEmpty();
    this.views = [];
  }
}
