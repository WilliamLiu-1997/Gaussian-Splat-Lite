import * as THREE from "three";
import { RAD_POOL_PAGE_COUNT } from "../../../data/defines.js";
import { PendingUploads } from "../../../data/pendingUploads.js";
import { getSplatByteLength } from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamCameras, streamViews } from "../StreamCameras.js";
import {
  checkStreamTransform,
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { RadPagePools } from "./RadPagePools.js";
import { RadStreamBatch } from "./RadStreamBatch.js";
import { RadStreamLoader } from "./RadStreamLoader.js";
import {
  preparationRequestBytes,
  selectionIndexBytes,
} from "./prepareRadSelection.js";
import { radChunkIndex, radPageCosts, radPoolBytes } from "./radLod.js";
function pendingPageBytes(page) {
  // Registration copies are charged separately once decoding completes.
  if (page.storage?.phase === "decoded")
    return getSplatByteLength(page.storage.data);
  return page.load ? page.input.costs.pending : 0;
}
function budgetTolerance(value) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("splatBudgetTolerance must be finite and nonnegative");
  return value;
}
/** Camera-driven RAD tree cuts with crossfades, on-demand pages and cooldown. */
export class RadStreamScheduler {
  constructor(options = {}) {
    if (options.sources !== undefined)
      throw new Error("Use addSource() to add RAD inputs after construction");
    this.options = { onChange: options.onChange, onError: options.onError };
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.pages = new Set();
    this.pools = new RadPagePools(this);
    this.matrix = new THREE.Matrix4();
    this.inputs = new Map();
    this.nextSourceId = 0;
    this.sourceRevision = 0;
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
      this.maxConcurrentLoads,
      this.maxSh,
      () => this.changed(),
      (error) => this.stopRefinement(error),
    );
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    void this.firstRenderable.catch(() => {});
  }
  /** Current source IDs in insertion order, including pending additions. */
  get sourceIds() {
    return [...this.inputs.keys()];
  }
  /** Resolves to a stable ID once this input's metadata is ready. */
  addSource(options) {
    this.abort.signal.throwIfAborted();
    if (this.refinementStopped)
      throw new Error("RAD detail selection has stopped");
    if (this.nextSourceId > 0xffffffff)
      throw new Error("RAD source ID capacity exceeded");
    const input = {
      id: this.nextSourceId++,
      transform: checkStreamTransform(
        options.transform ?? new THREE.Matrix4(),
      ).clone(),
      bounds: new THREE.Box3(),
      controller: new AbortController(),
      pages: new Map(),
    };
    this.inputs.set(input.id, input);
    const ready = this.initializeSource(input, options);
    void ready.catch(() => {});
    return ready;
  }
  /** Cancel and release one input without changing other IDs or displayed cuts. */
  removeSource(id) {
    const input = this.inputs.get(id);
    if (!input) return false;
    this.inputs.delete(id);
    input.controller.abort();
    this.sourceRevision++;
    this.invalidatePendingSelection();
    this.loader.removeSource(id);
    for (const page of input.pages.values()) {
      page.load?.abort();
      this.releasePage(page);
      this.pages.delete(page);
      this.wanted.delete(page);
      this.displayed?.pages.delete(page);
      this.rootPages.delete(page);
    }
    input.pages.clear();
    this.pools.removeViews(input);
    this.updatePageBudget();
    if (!this.rootPages.size) this.displayed = undefined;
    this.revision++;
    this.pools.releaseEmpty();
    this.checkFirstRenderable();
    this.scheduleRetry();
    void this.requestSelection();
    this.changed();
    return true;
  }
  /** A source's current settings; IDs are never renumbered or reused. */
  getSourceSettings(id) {
    return { transform: this.input(id).transform.clone() };
  }
  /** Change an input's transform; loaded data is kept. */
  setSourceSettings(id, { transform }) {
    const input = this.input(id);
    if (transform === undefined) return;
    input.transform.copy(checkStreamTransform(transform));
    for (const batch of this.pools.viewsOf(input)) {
      batch.matrix.copy(input.transform);
      batch.matrixWorldNeedsUpdate = true;
    }
    this.revision++;
    this.changed();
  }
  input(id) {
    const input = this.inputs.get(id);
    if (!input) throw new Error(`RAD source ${id} does not exist`);
    return input;
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
      residentMeshes: 0,
      residentCpuBytes:
        loader.cachedBytes + loader.selectionBytes + loader.paletteBytes,
      residentGpuBytes: loader.paletteBytes,
      pendingBytes:
        this.loader.pendingRegistrationBytes +
        (this.preparation?.bytes ?? 0) +
        this.pools.pendingBytes +
        selectionIndexBytes(ready?.sources),
      loadingChunks: 0,
      loadProgress: 0,
      downloadedBytes: loader.downloadedBytes,
      peakWasmMemoryBytes: loader.peakWasmMemoryBytes,
      pageBudget: this.pageBudget,
      allocatedPages: 0,
      freePages: 0,
      pendingGpuBytes: this.pools.pendingGpuBytes,
      lodTimeMs: this.lodTimeMs,
    };
    for (const pool of this.pools) {
      stats.allocatedPages += pool.slots.length;
      for (const page of pool.slots) if (!page) stats.freePages++;
      stats.residentCpuBytes += pool.storage.getByteLength();
      stats.residentGpuBytes += pool.storage.textureByteLength;
    }
    for (const batch of this.pools.views()) {
      stats.residentMeshes++;
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
        if (this.wanted.has(page) && this.displayed?.pages.has(page))
          readyPages++;
      }
      if (page.load) stats.loadingChunks++;
      stats.pendingBytes += pendingPageBytes(page);
    }
    if (!this.disposed) {
      stats.loadProgress =
        !this.shown ||
        (!this.rootPages.size &&
          [...this.inputs.values()].every((input) => input.metadata))
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
    const box = new THREE.Box3();
    if (this.disposed) return box;
    for (const { bounds, transform } of this.inputs.values())
      if (!bounds.isEmpty()) box.union(bounds.clone().applyMatrix4(transform));
    // Coarse centers can cluster inside large Gaussians. Include their extent
    // here so callers can frame the scene without inspecting owned batches.
    for (const batch of this.pools.views()) {
      if (!batch.numSplats) continue;
      box.union(batch.getBoundingBox(false).applyMatrix4(batch.matrix));
    }
    return box;
  }
  async initializeSource(input, options) {
    const { id, controller } = input;
    try {
      const metadata = await this.loader.addSource(
        id,
        options,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      input.metadata = metadata;
      input.numSh = Math.min(metadata.header.meta.maxSh ?? 0, this.maxSh);
      const codeCount = metadata.header.meta.shCodeCount ?? 0;
      input.indexedSh = input.numSh > 0 && codeCount > 0;
      input.storageSh = input.indexedSh ? 4 + input.numSh : input.numSh;
      input.costs = radPageCosts(input.numSh, input.indexedSh);
      if (metadata.header.meta.count) {
        this.rootPages.add(this.page(id, 0));
      }
      this.updatePageBudget();
      if (this.splatBudget < this.rootPages.size)
        throw new Error("splatBudget must cover every RAD input root");
      const { cpu, gpu } = this.rootPoolBytes();
      if (cpu > this.maxResidentCpuBytes)
        throw new Error(
          `RAD maxResidentCpuBytes must be at least ${cpu} bytes for these inputs`,
        );
      if (gpu > this.maxResidentGpuBytes)
        throw new Error(
          `RAD maxResidentGpuBytes must be at least ${gpu} bytes for these inputs`,
        );
      if (metadata.header.meta.count) this.wanted.add(this.page(id, 0));
      this.sourceRevision++;
      this.invalidatePendingSelection();
      this.revision++;
      this.checkFirstRenderable();
      this.pump();
      this.changed();
      controller.signal.throwIfAborted();
      return id;
    } catch (error) {
      const failed = !controller.signal.aborted && !this.disposed;
      if (failed && this.inputs.size === 1) this.rejectFirst(error);
      this.removeSource(id);
      if (failed && !this.refinementStopped)
        notifyStreamError(
          this.options,
          error,
          options.url ?? options.file?.name ?? "RAD",
        );
      throw error;
    }
  }
  /** Resident bytes of the pools that hold every input's root page. */
  rootPoolBytes() {
    const roots = new Map();
    for (const input of this.inputs.values()) {
      if (!input.metadata?.header.meta.count) continue;
      const entry = roots.get(input.storageSh) ?? {
        costs: input.costs,
        pages: 0,
      };
      entry.pages++;
      roots.set(input.storageSh, entry);
    }
    let cpu = this.loader.residentCpuOverheadBytes;
    let gpu = this.loader.residentGpuOverheadBytes;
    for (const { costs, pages } of roots.values()) {
      const bytes = radPoolBytes(costs, pages);
      cpu += bytes.cpu;
      gpu += bytes.gpu;
    }
    return { cpu, gpu };
  }
  updatePageBudget() {
    let pages = 0;
    let cpu = Number.POSITIVE_INFINITY;
    let gpu = Number.POSITIVE_INFINITY;
    for (const input of this.inputs.values()) {
      if (!input.metadata?.header.meta.count) continue;
      pages += input.metadata.header.meta.chunks.length;
      cpu = Math.min(cpu, input.costs.cpu);
      gpu = Math.min(gpu, input.costs.gpu);
    }
    // An upper bound; traversal reserves whole pools shared by equal SH degrees.
    const pool = radPoolBytes({ cpu, gpu });
    this.pageBudget = Math.max(
      0,
      Math.min(
        pages,
        Math.floor(
          (this.maxResidentCpuBytes - this.loader.residentCpuOverheadBytes) /
            pool.cpu,
        ) * RAD_POOL_PAGE_COUNT,
        Math.floor(
          (this.maxResidentGpuBytes - this.loader.residentGpuOverheadBytes) /
            pool.gpu,
        ) * RAD_POOL_PAGE_COUNT,
      ),
    );
  }
  checkFirstRenderable() {
    // Pending metadata may still introduce a root that can load successfully.
    for (const input of this.inputs.values()) if (!input.metadata) return;
    const roots = [...this.rootPages];
    if (!roots.length) this.resolveFirst(this);
    else if (roots.every((page) => page.retryAt === Number.POSITIVE_INFINITY))
      this.rejectFirst(roots[0].error);
  }
  /**
   * Call before rendering. Registered cameras share one cut at the greatest
   * detail any of them needs.
   */
  update() {
    if (this.disposed) return false;
    const cameras = this.streamCameras.seeing(this.group.layers);
    if (!this.inputs.size) return false;
    const now = performance.now();
    for (const batch of this.pools.views())
      batch.layers.mask = this.group.layers.mask;
    if (this.refinementStopped) {
      let changed = this.updateFade(now);
      changed = this.pools.releaseUnused(now, true) || changed;
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
        changed = this.pools.clearViews() || changed;
        this.cancelUnusedLoads();
      }
    }
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
      for (const page of this.rootPages)
        if (page.storage?.slot === undefined) this.wanted.add(page);
    changed = this.updateFade(now) || changed;
    if (shown) this.reservePages();
    if (this.pools.busy) {
      changed = this.pools.update() || changed;
      // Traversal and loading do not depend on slot placement.
      if (shown) {
        void this.requestSelection();
        this.pump();
      }
      if (changed) this.changed();
      return changed;
    }
    // Waiting cut pages first, then the latest traversal's priority order.
    if (shown)
      changed =
        this.pools.write(
          new Set([...(this.ready?.pages ?? []), ...this.wanted]),
        ) || changed;
    const preparation = this.preparation;
    if (preparation?.result && !this.displayed?.transition) {
      this.preparation = undefined;
      if (!preparation.cancelled && shown)
        changed =
          this.applySelection(preparation.result, preparation.pools, now) ||
          changed;
    }
    // Reclaim over-budget pools before another cut starts preparing or fading.
    // Keep expired caches until a pending view/budget decision can reuse them.
    const allowRelease = !shown || this.lastRequestedRevision === this.revision;
    changed = this.pools.releaseUnused(now, allowRelease) || changed;
    // Keep drawing the old cut until its replacement is prepared.
    if (
      this.ready &&
      !this.pools.busy &&
      !this.preparation &&
      !this.displayed?.transition &&
      this.selectionPagesReady(this.ready.selection)
    ) {
      const { selection: selected, reselect } = this.ready;
      this.ready = undefined;
      if (selected.changedChunks.length) void this.prepareSelection(selected);
      else
        changed =
          this.applySelection({ selection: selected, fade: false }, [], now) ||
          changed;
      if (reselect) this.revision++;
    }
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
      : (this.displayed?.selectionId ?? 0);
  }
  async requestSelection() {
    if (
      this.disposed ||
      this.refinementStopped ||
      !this.shown ||
      this.traversal ||
      // Let the waiting cut and budget reclamation run before pinning more pages.
      (this.ready && this.pools.overBudget) ||
      !this.rootPages.size ||
      !this.views.length ||
      this.lastRequestedRevision === this.revision
    )
      return;
    const traversal = new Set(this.pools.pages());
    const residentChunks = [];
    for (const page of traversal)
      if (!page.registration) residentChunks.push(page.input.id, page.index);
    if (
      ![...this.rootPages].some(
        (page) => traversal.has(page) && !page.registration,
      )
    )
      return;
    const sourceRevision = this.sourceRevision;
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
        sources: [...this.inputs.values()]
          .filter((input) => input.metadata)
          .map((input) => ({
            id: input.id,
            numSh: input.storageSh,
            transform: input.transform.elements,
            pageCpuBytes: input.costs.cpu,
            pageGpuBytes: input.costs.gpu,
          })),
        splatBudget,
        splatBudgetTolerance,
        maxResidentCpuBytes:
          this.maxResidentCpuBytes - this.loader.residentCpuOverheadBytes,
        maxResidentGpuBytes:
          this.maxResidentGpuBytes - this.loader.residentGpuOverheadBytes,
        pixelThreshold: 1,
        residentChunks,
        previousId,
        displayedId: this.displayed?.selectionId,
        readyId: this.ready?.selection.selectionId,
        fade: this.fadeDurationMs > 0,
      });
      if (
        this.disposed ||
        sourceRevision !== this.sourceRevision ||
        !this.shown ||
        splatBudget !== this.splatBudget ||
        splatBudgetTolerance !== this.splatBudgetTolerance
      )
        return;
      this.lodTimeMs = performance.now() - started;
      // Keep the selected tree path while its reserved pages await writing.
      this.wanted = new Set(this.selectionPages(selection.wantedChunks));
      for (const page of this.selectionPages(selection.touchedChunks))
        this.wanted.add(page);
      const now = performance.now();
      // Track even undecoded requests under their input for source-local removal.
      for (const page of this.wanted) page.lastUsed = now;
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
          pages: new Set(this.selectionPages(selection.touchedChunks)),
          reselect: false,
        };
      }
      this.changed();
    } catch (error) {
      if (sourceRevision === this.sourceRevision) this.stopRefinement(error);
    } finally {
      this.traversal = undefined;
      // Each accepted decision retires unused caches before the next snapshot,
      // even if the camera kept moving while the worker was selecting.
      if (!this.disposed) {
        const revision = this.revision;
        this.cancelUnusedLoads();
        // Reuse retired slots before another traversal pins its snapshot.
        this.reservePages();
        const released = this.pools.releaseUnused(
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
  *selectionPages(chunks) {
    // Worker page references are [source ID, local chunk] pairs in priority order.
    for (let offset = 0; offset < chunks.length; offset += 2)
      yield this.page(chunks[offset], chunks[offset + 1]);
  }
  selectionPagesReady(selection) {
    // Shared and outgoing nodes are already displayed; only changed pages may
    // still be unwritten. Ancestors need not delay publishing the selected cut.
    for (const page of this.selectionPages(selection.changedChunks))
      if (page.storage?.phase !== "resident") return false;
    return true;
  }
  /** Snapshot pool selections for these cuts, locating pages by their storage. */
  snapshotPools(sources, pools, locate = (page) => page.storage) {
    const rangesByPool = new Map(pools.map((pool) => [pool, []]));
    for (const cut of sources) {
      const input = this.input(cut.source);
      const indices = cut.fade?.indices ?? cut.indices;
      // Resolve source-local file indices once per page, including unpublished moves.
      for (let start = 0; start < indices.length; ) {
        const chunk = radChunkIndex(input.metadata.header.meta, indices[start]);
        const page = input.pages.get(chunk);
        const storage = page && locate(page);
        const slot = storage?.slot;
        if (slot === undefined)
          throw new Error("RAD cut references a retired page");
        const pageEnd = page.base + page.count;
        let end = start + 1;
        let high = indices.length;
        while (end < high) {
          const middle = Math.floor((end + high) / 2);
          if (indices[middle] < pageEnd) end = middle + 1;
          else high = middle;
        }
        rangesByPool.get(storage.pool)?.push({
          start,
          end,
          slot,
          chunkIndex: page.index,
          sourceBase: page.base,
          input: input.id,
        });
        start = end;
      }
    }
    return Array.from(rangesByPool, ([pool, ranges]) =>
      pool.storage.snapshotSelection(ranges),
    );
  }
  async prepareSelection(selection) {
    let preparation;
    try {
      const changedPools = new Set();
      for (const page of this.selectionPages(selection.changedChunks)) {
        const pool = page.storage?.pool;
        if (!pool) throw new Error("RAD transition references a retired page");
        changedPools.add(pool);
      }
      const pools = this.snapshotPools(selection.sources, [...changedPools]);
      preparation = {
        selectionId: selection.selectionId,
        // Pin physical slots until the reply, even when cancelled or hidden.
        pages: new Set(this.pools.pages()),
        // Same order as the worker's pool snapshots and results.
        pools: [...changedPools],
        cancelled: false,
        bytes:
          // Reserve both the displayed and post-fade cuts.
          preparationRequestBytes(selection.sources, pools, 2) +
          selection.changedChunks.byteLength +
          selection.touchedChunks.byteLength +
          selection.wantedChunks.byteLength,
      };
      this.preparation = preparation;
      const result = await this.loader.prepareSelection({ selection, pools });
      if (this.preparation !== preparation) return;
      if (preparation.cancelled) {
        this.preparation = undefined;
      } else preparation.result = result;
    } catch (error) {
      if (this.disposed || this.preparation !== preparation) return;
      this.preparation = undefined;
      this.lastRequestedRevision = -1;
      if (!preparation?.cancelled) this.stopRefinement(error);
    }
    // A cancelled task releases its pool pins on either success or failure.
    if (preparation?.cancelled)
      this.pools.releaseUnused(performance.now(), true);
    this.changed();
  }
  applySelection(prepared, pools, now) {
    const { selection, fade } = prepared;
    this.commitPools(prepared.pools, pools);
    this.displayed = {
      // The worker retains the baseline; the main thread only needs its ID.
      selectionId: selection.selectionId,
      pages: new Set(this.selectionPages(selection.touchedChunks)),
      transition: fade ? { startedAt: now, pools } : undefined,
    };
    this.cancelUnusedLoads();
    if (selection.sources.some((cut) => cut.indices.length) && !fade)
      this.resolveFirst(this);
    return pools.length > 0;
  }
  commitPools(prepared, pools) {
    for (const [index, pool] of pools.entries()) {
      const result = prepared[index];
      pool.storage.commitSelection(result);
      const views = new Map();
      for (const cut of result.cuts) {
        const input = this.inputs.get(cut.input);
        const batch = pool.views.get(input) ?? this.createView(pool, input);
        batch.commitSelection(cut);
        if (batch.parent !== this.group) this.group.add(batch);
        views.set(input, batch);
        pool.views.delete(input);
      }
      for (const batch of pool.views.values()) batch.dispose();
      pool.views = views;
    }
  }
  invalidatePendingSelection() {
    this.pools.cancel();
    this.ready = undefined;
    // A cancelled preparation still owns its physical slots until the reply.
    if (this.preparation?.result) this.preparation = undefined;
    else if (this.preparation) this.preparation.cancelled = true;
  }
  clearSelectionState() {
    this.invalidatePendingSelection();
    this.displayed = undefined;
    this.wanted.clear();
  }
  /** Worker snapshots and waiting cuts pin pages without renewing cooldown. */
  isPagePinned(page) {
    return (
      this.traversal?.has(page) ||
      this.ready?.pages.has(page) ||
      this.preparation?.pages.has(page) ||
      this.pools.isMerging(page)
    );
  }
  cancelUnusedLoads() {
    for (const page of this.pages.values()) {
      if (
        !this.wanted.has(page) &&
        !this.isPagePinned(page) &&
        !this.rootPages.has(page)
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
    if (
      progress > 0 &&
      this.group.children.some((batch) => batch.numSplats > 0)
    )
      this.resolveFirst(this);
    let changed = false;
    if (progress === 1) displayed.transition = undefined;
    for (const pool of transition.pools) {
      // A pool released mid-fade has no views left to fade.
      if (!this.pools.has(pool)) continue;
      if (progress === 1) {
        const faded = pool.storage.finishFade();
        for (const [input, batch] of pool.views) {
          changed = batch.finishFade(faded) || changed;
          if (batch.numSplats === 0) {
            batch.dispose();
            pool.views.delete(input);
          }
        }
      } else if (pool.storage.setFadeProgress(progress))
        for (const batch of pool.views.values())
          changed = batch.fadeChanged() || changed;
    }
    return changed;
  }
  page(sourceId, index) {
    const input = this.input(sourceId);
    let page = input.pages.get(index);
    if (!page) {
      const { base, count } = input.metadata.header.meta.chunks[index];
      page = {
        index,
        base,
        count,
        input,
        failures: 0,
        retryAt: 0,
        lastUsed: performance.now(),
      };
      input.pages.set(index, page);
      this.pages.add(page);
    }
    return page;
  }
  pump() {
    if (this.disposed || this.refinementStopped) return;
    let loading = 0;
    for (const page of this.pages.values()) if (page.load) loading++;
    const now = performance.now();
    for (const page of this.wanted) {
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
      let result = await this.loader.loadChunk(
        page.input.id,
        page.index,
        signal,
      );
      if (!active()) {
        this.loader.releaseChunk(page.index, page.input.id);
        return;
      }
      registration = result.registration;
      page.registration = registration;
      // Decoded buffers stay owned here until written to the reserved slot.
      page.storage = { phase: "decoded", data: result.data };
      if (this.rootPages.has(page))
        this.setInitialBounds(page.input, result.data);
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
        if (registration) this.releasePage(page);
        page.error = error;
        page.retryAt = streamRetryAt(error, page.failures++);
        this.checkFirstRenderable();
        this.failed(error, page);
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
  setInitialBounds(input, data) {
    // The page worker computes these bounds during Morton reordering.
    const bounds = data.centerOnlyBoundingBox;
    input.bounds.min.fromArray(bounds);
    input.bounds.max.fromArray(bounds, 3);
    // The root-page radius covers initial bounds that collapse to one point.
    if (input.bounds.min.equals(input.bounds.max))
      input.bounds.expandByScalar(Math.max(0.001, data.rootRadius));
  }
  /** One input's records in this pool, with its own transform. */
  createView(pool, input) {
    const batch = new RadStreamBatch(
      pool.storage,
      input.numSh,
      pool.storage.indexedSh ? this.loader.palette(input.id) : undefined,
    );
    batch.matrixAutoUpdate = false;
    batch.matrix.copy(input.transform);
    batch.matrixWorldNeedsUpdate = true;
    batch.layers.mask = this.group.layers.mask;
    return batch;
  }
  /** File indices of the displayed cut, for rebuilding views after page moves. */
  async snapshotDisplayed() {
    const id = this.displayed?.selectionId;
    return id ? this.loader.snapshotSelection(id) : [];
  }
  reservePages() {
    if (this.pools.busy) return;
    // Missing pages are ordered by the LOD traversal's refinement priority.
    for (const page of this.wanted) {
      const storage = page?.storage;
      if (storage?.phase !== "decoded" || storage.slot !== undefined) continue;
      if (!this.pools.reserve(page)) {
        // Reclaim capacity when no slot is free and no new pool fits.
        this.pools.consolidate();
        return;
      }
      if (!page.registration) this.revision++;
    }
  }
  releasePage(page) {
    this.pools.release(page);
    page.registration = undefined;
    // Removing an input releases both worker caches in one message per worker.
    if (!page.input.controller.signal.aborted)
      this.loader.releaseChunk(page.index, page.input.id);
    this.revision++;
  }
  isPageRequired(page) {
    const storage = page.storage;
    const slot = storage?.slot;
    return (
      this.rootPages.has(page) ||
      this.displayed?.pages.has(page) ||
      this.wanted.has(page) ||
      (slot !== undefined && storage.pool.storage.isPageSelected(slot))
    );
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, page) {
    notifyStreamError(
      this.options,
      error,
      page ? this.loader.getChunkUrl(page.input.id, page.index) : "RAD",
    );
  }
  stopRefinement(error) {
    if (this.disposed || this.refinementStopped) return;
    this.pools.cancel();
    this.refinementStopped = true;
    this.ready = undefined;
    this.preparation = undefined;
    this.wanted.clear();
    this.retryTimer.dispose();
    for (const page of this.pages.values()) page.load?.abort(error);
    this.loader.dispose();
    for (const page of this.pages.values())
      if (page.storage?.phase === "decoded") this.releasePage(page);
    // No future update is guaranteed after the last source was removed.
    this.pools.releaseEmpty();
    this.rejectFirst(error);
    this.failed(error);
    this.changed();
  }
  scheduleRetry() {
    if (!this.refinementStopped) this.retryTimer.update(this.retryDeadlines());
  }
  *retryDeadlines() {
    for (const page of this.wanted) {
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
    for (const input of this.inputs.values()) input.controller.abort(reason);
    for (const page of this.pages.values()) page.load?.abort(reason);
    this.loader.dispose();
    this.preparation = undefined;
    this.clearSelectionState();
    this.pools.dispose();
    this.pages.clear();
    this.inputs.clear();
    this.rootPages.clear();
    this.traversal = undefined;
    this.views = [];
  }
}
