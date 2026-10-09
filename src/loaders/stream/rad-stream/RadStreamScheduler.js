import * as THREE from "three";
import { radPageTextureLayout } from "../../../data/RadPagedSplats.js";
import { SPLAT_BOUNDS_BLOCK_SIZE } from "../../../data/defines.js";
import {
  getSplatByteLength,
  getSplatTextureBytes,
} from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { getRadChunkSpan } from "../../rad/radFormat.js";
import { StreamByteBudget } from "../StreamByteBudget.js";
import { StreamCameras, streamViews } from "../StreamCameras.js";
import {
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamPendingLimit,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { RadStreamBatch } from "./RadStreamBatch.js";
import { RadStreamLoader } from "./RadStreamLoader.js";
import { radChunkIndex } from "./radLod.js";
function pendingPageBytes(page) {
  return page.storage?.phase === "decoded"
    ? getSplatByteLength(page.storage.data)
    : (page.load?.reservedBytes ?? 0);
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
    this.pageSize = 0;
    this.pageBudget = 0;
    this.numSh = 0;
    this.maxPagePendingBytes = 0;
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
    this.group = options.group ?? new THREE.Group();
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this.cooldownMs = settings.cooldownMs;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.loader = new RadStreamLoader(options, this.maxConcurrentLoads);
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.initialized = this.initialize().catch((error) => {
      this.rejectFirst(error);
      this.loader.dispose();
      throw error;
    });
    void this.initialized.catch(() => {});
    void this.firstRenderable.catch(() => {});
  }
  /** Selected-node budget. Assigning a new value requests LOD selection. */
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    if (value === this._splatBudget) return;
    this._splatBudget = positiveInteger(value, "splatBudget");
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
    let pendingBytes = 0;
    let residentChunks = 0;
    let loadingChunks = 0;
    for (const page of this.pages.values()) {
      if (page.storage?.phase === "resident") residentChunks++;
      if (page.load?.phase === "decoding") loadingChunks++;
      pendingBytes += pendingPageBytes(page);
    }
    return {
      visibleSplats: this.shown
        ? this.pools.reduce((sum, { batch }) => sum + batch.numSplats, 0)
        : 0,
      visibleMeshes: this.shown
        ? this.pools.filter(({ batch }) => batch.numSplats > 0).length
        : 0,
      residentChunks,
      residentMeshes: this.pools.length,
      residentBytes:
        this.pools.reduce(
          (sum, { batch }) => sum + batch.source.residentBytes,
          0,
        ) +
        loader.estimatedCodebookBytes +
        loader.bootstrapBytes +
        loader.cachedBytes +
        loader.selectionBytes +
        (this.displayed?.selection.indices.byteLength ?? 0),
      pendingBytes: pendingBytes + (this.preparation?.bytes ?? 0),
      loadingChunks,
      downloadedBytes: loader.downloadedBytes,
      peakWasmMemoryBytes: loader.peakWasmMemoryBytes,
      pageBudget: this.pageBudget,
      lodTimeMs: this.lodTimeMs,
    };
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
    const { meta } = await this.loader.initialize(this.abort.signal);
    this.abort.signal.throwIfAborted();
    if (meta.count && !meta.lodTree) {
      const error = new Error(
        "RAD streaming requires a LOD tree; load this file with SplatMesh instead",
      );
      error.name = "RadLodRequiredError";
      throw error;
    }
    this.meta = meta;
    this.numSh = meta.maxSh ?? 0;
    if (!meta.count) {
      this.resolveFirst(this);
      this.changed();
      return this;
    }
    this.pageSize = getRadChunkSpan(meta, 0).count;
    for (let index = 1; index < meta.chunks.length; index++)
      this.pageSize = Math.max(
        this.pageSize,
        getRadChunkSpan(meta, index).count,
      );
    // Validate the largest page against the texture layout limits.
    radPageTextureLayout({
      pageSize: this.pageSize,
      pageCount: 1,
    });
    const paddedCount = Math.ceil(this.pageSize / 2048) * 2048;
    this.maxPagePendingBytes =
      getSplatTextureBytes(paddedCount, this.numSh) +
      // Tree data, source IDs, Morton order and bounds awaiting LOD registration.
      this.pageSize * 30 +
      Math.ceil(this.pageSize / SPLAT_BOUNDS_BLOCK_SIZE) * (48 + 32);
    this.pageBudget = meta.chunks.length;
    this.wanted.add(0);
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
    if (shown && this.meta.count && !this.pages.get(0)?.storage?.allocation)
      this.wanted.add(0);
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
      // Apply the latest view after publishing or discarding this snapshot.
      this.revision++;
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
  async requestSelection() {
    if (
      this.disposed ||
      this.refinementStopped ||
      !this.shown ||
      this.traversal ||
      this.preparation ||
      !this.meta?.count ||
      !this.views.length ||
      this.lastRequestedRevision === this.revision ||
      !this.pages.get(0)?.storage?.allocation
    )
      return;
    const residentChunks = [...this.pages.values()]
      .filter((page) => page.storage?.allocation)
      .map((page) => page.index);
    const traversal = {
      pages: new Set(residentChunks),
      previous: this.displayed?.selection,
      splatBudget: this.splatBudget,
    };
    this.traversal = traversal;
    this.lastRequestedRevision = this.revision;
    const { previous, splatBudget } = traversal;
    const started = performance.now();
    let accepted = false;
    try {
      const selection = await this.loader.selectLod({
        views: this.views,
        splatBudget,
        pixelThreshold: 1,
        residentChunks,
        previousId: previous?.selectionId,
        readyId: this.ready?.selection.selectionId,
        fade: this.fadeDurationMs > 0,
      });
      if (this.disposed || !this.shown || splatBudget !== this.splatBudget)
        return;
      this.lodTimeMs = performance.now() - started;
      // Keep the selected tree path while its reserved pages await writing.
      this.wanted = new Set(selection.wantedChunks);
      for (const index of selection.touchedChunks) this.wanted.add(index);
      accepted = true;
      this.cancelUnusedLoads();
      this.pump();
      // A completed cut may be applied or hidden during traversal. Recompute
      // against its new fade baseline, but accept camera lag to avoid starvation.
      if (this.displayed?.selection !== previous || this.preparation) {
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
      if (!this.disposed) {
        this.stopRefinement(error);
      }
    } finally {
      if (this.traversal === traversal) this.traversal = undefined;
      // Each accepted decision retires unused caches before the next snapshot,
      // even if the camera kept moving while the worker was selecting.
      if (!this.disposed) {
        const revision = this.revision;
        this.cancelUnusedLoads();
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
            pageStart: pool.batch.source.pageStart(slot),
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
          // Opacity tables, current/post-fade page counts and bounds, dirty flags.
          pools.reduce(
            (bytes, pool) =>
              bytes + pool.opacityBlocks.byteLength + pool.pageCount * 9 + 96,
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
    const changed = affected.length > 0;
    let index = 0;
    for (const pool of affected) {
      pool.batch.commitSelection(prepared.pools[index++]);
      if (pool.batch.numSplats > 0 && pool.batch.parent !== this.group)
        this.group.add(pool.batch);
      else if (pool.batch.numSplats === 0) pool.batch.removeFromParent();
    }
    // Unchanged nodes keep the fade baseline valid for an in-flight decision.
    let displayedSelection = selection;
    if (this.displayed && !selection.changedChunks.length) {
      const previous = this.displayed.selection;
      previous.touchedChunks = selection.touchedChunks;
      previous.wantedChunks = selection.wantedChunks;
      displayedSelection = previous;
    }
    this.displayed = {
      selection: displayedSelection,
      pages: new Set(selection.touchedChunks),
      transition: fade ? { startedAt: now, pools: affected } : undefined,
    };
    this.cancelUnusedLoads();
    if (selection.indices.length && !fade) this.resolveFirst(this);
    return changed;
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
      this.traversal?.pages.has(index) ||
      this.ready?.pages.has(index) ||
      this.preparation?.pages.has(index)
    );
  }
  cancelUnusedLoads() {
    for (const page of this.pages.values()) {
      if (
        !this.wanted.has(page.index) &&
        !this.isPagePinned(page.index) &&
        page.index !== 0
      ) {
        page.load?.controller.abort();
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
      const range = getRadChunkSpan(this.meta, index);
      page = {
        index,
        base: range.base,
        count: range.count,
        failures: 0,
        retryAt: 0,
      };
      this.pages.set(index, page);
    }
    return page;
  }
  pump() {
    if (this.disposed || this.refinementStopped || !this.meta) return;
    let loading = 0;
    let pendingBytes = 0;
    for (const page of this.pages.values()) {
      if (page.load?.phase === "decoding") loading++;
      pendingBytes += pendingPageBytes(page);
    }
    const pending = new StreamByteBudget(
      streamPendingLimit(this.maxConcurrentLoads, this.maxPagePendingBytes),
      pendingBytes,
    );
    const now = performance.now();
    for (const index of this.wanted) {
      const page = this.page(index);
      if (page.storage || page.load || now < page.retryAt) continue;
      if (
        loading >= this.maxConcurrentLoads ||
        !pending.reserve(this.maxPagePendingBytes)
      )
        break;
      const load = {
        controller: new AbortController(),
        phase: "decoding",
        reservedBytes: this.maxPagePendingBytes,
      };
      page.load = load;
      loading++;
      void this.loadPage(page, load);
    }
  }
  async loadPage(page, load) {
    const { signal } = load.controller;
    const active = () =>
      !this.disposed && !signal.aborted && page.load === load;
    try {
      const data = await this.loader.loadChunk(page.index, signal, () => {
        if (!active()) return;
        load.phase = "registering";
        this.pump();
      });
      if (!active()) return;
      page.storage = { phase: "decoded", data };
      page.failures = 0;
      if (page.index === 0) this.setInitialBounds(data);
      this.reservePages();
    } catch (error) {
      if (active()) {
        if (this.loader.lodWorkerLost) return this.stopRefinement(error);
        page.retryAt = streamRetryAt(error, page.failures++);
        if (page.index === 0 && page.retryAt === Number.POSITIVE_INFINITY)
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
    this.bounds.min.fromArray(bounds);
    this.bounds.max.fromArray(bounds, 3);
    if (this.bounds.min.equals(this.bounds.max))
      this.bounds.expandByScalar(Math.max(0.001, data.rootRadius ?? 1));
  }
  findSlot() {
    for (const pool of this.pools) {
      const slot = pool.slots.indexOf(undefined);
      if (slot !== -1) return { pool, slot };
    }
    const capacity = this.pools.reduce(
      (sum, pool) => sum + pool.slots.length,
      0,
    );
    // Each chunk owns at most one slot. An unallocated page therefore leaves
    // room below pageBudget, which is the dataset's total chunk count.
    const count = Math.min(8, this.pageBudget - capacity);
    const batch = new RadStreamBatch({
      pageSize: this.pageSize,
      pageCount: count,
      numSh: this.numSh,
    });
    batch.layers.mask = this.group.layers.mask;
    const pool = {
      batch,
      slots: Array(count).fill(undefined),
    };
    this.pools.push(pool);
    return { pool, slot: 0 };
  }
  reservePages() {
    for (const page of this.pages.values()) {
      const storage = page.storage;
      if (storage?.phase !== "decoded" || storage.allocation) continue;
      const available = this.findSlot();
      const { pool, slot } = available;
      pool.slots[slot] = page;
      storage.allocation = available;
      this.revision++;
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
      pool.batch.source.writePage(slot, storage.data);
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
    page.expiresAt = undefined;
    this.loader.releaseChunk(page.index);
    this.revision++;
  }
  releaseUnused(now, allowRelease) {
    let changed = false;
    for (const page of this.pages.values()) {
      const allocation = page.storage?.allocation;
      if (!allocation || page.index === 0) continue;
      const { pool, slot } = allocation;
      if (
        this.displayed?.pages.has(page.index) ||
        this.wanted.has(page.index) ||
        pool.batch.source.isPageSelected(slot)
      ) {
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
    // Like streamed SOG, release source storage once its contents retire.
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
  /** Map a raycast hit's rendered index back to its stable file index. */
  getGlobalIndex(mesh, renderedIndex) {
    const pool = this.pools.find(({ batch }) => batch === mesh);
    if (!pool) throw new Error("Mesh does not belong to this RAD dataset");
    return pool.batch.source.getSourceIndex(renderedIndex);
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, index) {
    notifyStreamError(this.options, error, this.loader.getChunkUrl(index));
  }
  stopRefinement(error) {
    this.refinementStopped = true;
    this.ready = undefined;
    this.preparation = undefined;
    this.wanted.clear();
    this.retryTimer.dispose();
    for (const page of this.pages.values()) page.load?.controller.abort(error);
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
    for (const page of this.pages.values()) page.load?.controller.abort(reason);
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
