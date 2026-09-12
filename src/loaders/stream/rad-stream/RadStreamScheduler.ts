import * as THREE from "three";
import {
  type RadSelectionRange,
  radPageTextureLayout,
} from "../../../data/RadPagedSplats";
import {
  getSplatByteLength,
  getSplatTextureBytes,
} from "../../../data/splatData";
import type { RadMeta, RadStreamChunk } from "../../rad/radFormat";
import { getRadChunkSpan } from "../../rad/radFormat";
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
import { RadStreamBatch } from "./RadStreamBatch";
import {
  RadStreamLoader,
  type RadStreamLoaderOptions,
} from "./RadStreamLoader";
import type { RadSelectionPreparation } from "./prepareRadSelection";
import type { RadStreamSelection, RadVersionedSelection } from "./radFade";
import { type RadLodView, radChunkIndex } from "./radLod";

export type RadStreamSchedulerOptions = RadStreamLoaderOptions &
  StreamSchedulerOptions;
export type RadStreamStats = StreamStats & {
  pageBudget: number;
  lodTimeMs: number;
};

type Pool = {
  batch: RadStreamBatch;
  slots: (Page | undefined)[];
};
type Page = {
  index: number;
  base: number;
  count: number;
  /** Reserved before writing; data remains present until the slot is populated. */
  pool?: Pool;
  slot?: number;
  data?: RadStreamChunk;
  controller?: AbortController;
  decoded?: boolean;
  reservedBytes: number;
  failures: number;
  retryAt: number;
  expiresAt?: number;
};

type Preparation = {
  /** Same order as the worker's pool snapshots and results. */
  pools: Pool[];
  pages: Set<number>;
  cancelled: boolean;
  bytes: number;
  result?: RadSelectionPreparation;
};

/** Camera-driven RAD tree cuts with crossfades, on-demand pages and cooldown. */
export class RadStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly cooldownTicks: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  readonly maxUploadBytesPerUpdate: number;
  private _splatBudget: number;
  private readonly loader: RadStreamLoader;
  private readonly abort = new AbortController();
  private readonly pages = new Map<number, Page>();
  private readonly pools: Pool[] = [];
  private readonly bounds = new THREE.Box3();
  private readonly matrix = new THREE.Matrix4();
  private readonly point = new THREE.Vector3();
  private meta?: RadMeta;
  private pageSize = 0;
  private pageStride = 0;
  private pageBudget = 0;
  private numSh = 0;
  private maxPagePendingBytes = 0;
  private tick = 0;
  private disposed = false;
  private shown = true;
  private selection?: RadVersionedSelection;
  private readySelection?: RadStreamSelection;
  private preparation?: Preparation;
  private reselectAfterReady = false;
  private transition?: {
    startedAt: number;
    pools: Pool[];
  };
  private wanted = new Set<number>();
  private protectedPages = new Set<number>();
  private inFlightPages?: Set<number>;
  private readyPages?: Set<number>;
  private revision = 0;
  private lastRequestedRevision = -1;
  private lastViewKey = "";
  private views: RadLodView[] = [];
  private lodTimeMs = 0;
  private resolveFirst!: (value: this) => void;
  private rejectFirst!: (error: unknown) => void;

  constructor(private readonly options: RadStreamSchedulerOptions) {
    this.group = options.group ?? new THREE.Group();
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this.cooldownTicks = settings.cooldownTicks;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.maxUploadBytesPerUpdate = settings.maxUploadBytesPerUpdate;
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
  get splatBudget(): number {
    return this._splatBudget;
  }

  set splatBudget(value: number) {
    if (value === this._splatBudget) return;
    this._splatBudget = positiveInteger(value, "splatBudget");
    if (this.preparation) this.preparation.cancelled = true;
    this.revision++;
    this.readySelection = undefined;
    this.readyPages = undefined;
    this.reselectAfterReady = false;
    void this.requestSelection();
  }

  get stats(): RadStreamStats {
    const loader = this.loader.stats;
    let pendingBytes = 0;
    let residentChunks = 0;
    let loadingChunks = 0;
    for (const page of this.pages.values()) {
      if (page.pool && !page.data) residentChunks++;
      if (page.controller && !page.decoded) loadingChunks++;
      pendingBytes += page.data
        ? getSplatByteLength(page.data)
        : page.reservedBytes;
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
        (this.selection?.indices.byteLength ?? 0),
      pendingBytes: pendingBytes + (this.preparation?.bytes ?? 0),
      loadingChunks,
      downloadedBytes: loader.downloadedBytes,
      peakWasmMemoryBytes: loader.peakWasmMemoryBytes,
      pageBudget: this.pageBudget,
      lodTimeMs: this.lodTimeMs,
    };
  }

  /** Group-local root bounds plus selected Gaussian extents; approximate while streaming. */
  getBoundingBox(): THREE.Box3 {
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

  private async initialize() {
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
    this.pageStride = radPageTextureLayout({
      pageSize: this.pageSize,
      pageCount: 1,
    }).pageStride;
    const paddedCount = Math.ceil(this.pageSize / 2048) * 2048;
    this.maxPagePendingBytes =
      getSplatTextureBytes(paddedCount, this.numSh) +
      // Centers, radii and child arrays awaiting LOD worker registration.
      this.pageSize * 22;
    this.pageBudget = meta.chunks.length;
    this.wanted.add(0);
    this.pump();
    this.changed();
    return this;
  }

  /** Call before rendering; physical pixel dimensions include device pixel ratio.
   * ArrayCamera uses a shared cut selected at the greatest per-eye detail. */
  update(
    camera: THREE.Camera,
    viewport: { width: number; height: number } = { width: 1024, height: 1024 },
  ): boolean {
    if (this.disposed || !this.meta) return false;
    if (
      !(viewport.width > 0 && viewport.height > 0) ||
      !Number.isFinite(viewport.width + viewport.height)
    )
      throw new Error("RAD viewport dimensions must be positive and finite");
    this.tick++;
    for (const { batch } of this.pools) batch.source.beginUpdate();
    const now = performance.now();
    camera.updateWorldMatrix(true, false);
    this.group.updateWorldMatrix(true, false);
    let shown = true;
    for (
      let object: THREE.Object3D | null = this.group;
      object;
      object = object.parent
    )
      shown &&= object.visible;
    shown &&= camera.layers.test(this.group.layers);
    let changed = false;
    if (shown !== this.shown) {
      this.shown = shown;
      this.revision++;
      if (!shown) {
        if (this.preparation) this.preparation.cancelled = true;
        for (const { batch } of this.pools)
          changed = batch.clearSelection() || changed;
        this.selection = undefined;
        this.readySelection = undefined;
        this.reselectAfterReady = false;
        this.readyPages = undefined;
        this.transition = undefined;
        this.protectedPages.clear();
        this.wanted.clear();
        this.cancelUnusedLoads();
      }
    }
    for (const { batch } of this.pools)
      batch.layers.mask = this.group.layers.mask;
    const cameras = (camera as THREE.ArrayCamera).isArrayCamera
      ? (camera as THREE.ArrayCamera).cameras
      : [camera];
    this.views = cameras.map((eye) => {
      eye.updateWorldMatrix(true, false);
      this.matrix
        .copy(eye.matrixWorld)
        .invert()
        .multiply(this.group.matrixWorld);
      const eyeViewport = (
        eye as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }
      ).viewport;
      const width = eyeViewport?.z ?? viewport.width;
      const height = eyeViewport?.w ?? viewport.height;
      const p = eye.projectionMatrix.elements;
      return {
        viewFromObject: this.matrix.elements.slice(),
        projectionRows: [p[0], p[4], p[8], p[12], p[1], p[5], p[9], p[13]],
        pixelScale:
          Math.max(Math.abs(p[0]) * width, Math.abs(p[5]) * height) / 2,
        orthographic:
          (eye as THREE.OrthographicCamera).isOrthographicCamera === true,
      };
    });
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
    if (shown && this.meta.count && !this.pages.get(0)?.pool)
      this.wanted.add(0);
    changed = this.updateFade(now) || changed;
    if (shown) {
      this.reservePages();
      changed = this.uploadPages() || changed;
    }
    const preparation = this.preparation;
    if (preparation?.result && !this.transition) {
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
      this.readySelection &&
      !this.preparation &&
      !this.transition &&
      this.selectionPagesReady(this.readySelection)
    ) {
      const selected = this.readySelection;
      this.readySelection = undefined;
      this.readyPages = undefined;
      if (selected.changedChunks.length) void this.prepareSelection(selected);
      else
        changed =
          this.applySelection(
            { selection: selected, fade: false, pools: [] },
            [],
            now,
          ) || changed;
      if (this.reselectAfterReady) {
        this.reselectAfterReady = false;
        this.revision++;
      }
    }
    changed = this.releaseUnused() || changed;
    if (shown) {
      void this.requestSelection();
      this.pump();
    }
    if (changed) this.changed();
    return changed;
  }

  private async requestSelection() {
    if (
      this.disposed ||
      !this.shown ||
      this.inFlightPages ||
      this.preparation ||
      !this.meta?.count ||
      !this.views.length ||
      this.lastRequestedRevision === this.revision ||
      !this.pages.get(0)?.pool
    )
      return;
    const residentChunks = [...this.pages.values()]
      .filter((page) => page.pool)
      .map((page) => page.index);
    this.inFlightPages = new Set(residentChunks);
    this.lastRequestedRevision = this.revision;
    const previous = this.selection;
    const splatBudget = this.splatBudget;
    const started = performance.now();
    try {
      const selection = await this.loader.selectLod({
        views: this.views,
        splatBudget,
        pixelThreshold: 1,
        residentChunks,
        previousId: previous?.selectionId,
        readyId: this.readySelection?.selectionId,
        fade: this.fadeDurationMs > 0,
      });
      if (this.disposed || !this.shown || splatBudget !== this.splatBudget)
        return;
      this.lodTimeMs = performance.now() - started;
      // Keep the selected tree path while its reserved pages await writing.
      this.wanted = new Set(selection.wantedChunks);
      for (const index of selection.touchedChunks) this.wanted.add(index);
      this.cancelUnusedLoads();
      this.pump();
      // A completed cut may be applied or hidden during traversal. Recompute
      // against its new fade baseline, but accept camera lag to avoid starvation.
      if (this.selection !== previous || this.preparation) {
        this.lastRequestedRevision = -1;
        this.changed();
        return;
      }
      if (
        this.readySelection &&
        !this.transition &&
        !this.selectionPagesReady(selection)
      ) {
        // Finish the waiting cut instead of chasing newly decoded pages forever.
        // Loading still follows the latest result; refresh after publication.
        this.reselectAfterReady = true;
      } else {
        this.readySelection = selection;
        this.readyPages = new Set(selection.touchedChunks);
        this.reselectAfterReady = false;
      }
      this.changed();
    } catch (error) {
      if (!this.disposed) {
        this.rejectFirst(error);
        this.failed(error, -1);
      }
    } finally {
      this.inFlightPages = undefined;
      // Release unused reservations before the next snapshot pins them again.
      if (!this.disposed) {
        const revision = this.revision;
        this.cancelUnusedLoads();
        const released = this.releaseUnused();
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

  private selectionPagesReady(selection: RadStreamSelection) {
    // Shared and outgoing nodes are already displayed; only changed pages may
    // still be unwritten. Ancestors need not delay publishing the selected cut.
    return selection.changedChunks.every((index) => {
      const page = this.pages.get(index);
      return page?.pool && !page.data;
    });
  }

  private async prepareSelection(selection: RadStreamSelection) {
    let preparation: Preparation | undefined;
    try {
      const rangesByPool = new Map<Pool, RadSelectionRange[]>();
      for (const index of selection.changedChunks) {
        const pool = this.pages.get(index)?.pool;
        if (!pool) throw new Error("RAD transition references a retired page");
        if (!rangesByPool.has(pool)) rangesByPool.set(pool, []);
      }
      const indices = selection.fade?.indices ?? selection.indices;
      const meta = this.meta as RadMeta;
      let selectedCount = 0;
      // Sorted file indices let us resolve each page once, without a per-node
      // scan on the main thread. Only changed pools need replacement data.
      for (let start = 0; start < indices.length; ) {
        const page = this.pages.get(radChunkIndex(meta, indices[start]));
        if (!page?.pool || page.slot === undefined)
          throw new Error("RAD cut references a retired page");
        const pageEnd = page.base + page.count;
        let end = start + 1;
        let high = indices.length;
        while (end < high) {
          const middle = Math.floor((end + high) / 2);
          if (indices[middle] < pageEnd) end = middle + 1;
          else high = middle;
        }
        const ranges = rangesByPool.get(page.pool);
        if (ranges) {
          ranges.push({
            start,
            end,
            slot: page.slot,
            sourceOffset:
              page.pool.batch.source.pageStart(page.slot) - page.base,
          });
          selectedCount += end - start;
        }
        start = end;
      }
      const pools = Array.from(rangesByPool, ([pool, ranges]) =>
        pool.batch.source.snapshotSelection(ranges),
      );
      // Pin physical slots until the reply, even when cancelled or hidden.
      const pages = new Set<number>();
      for (const page of this.pages.values())
        if (page.pool) pages.add(page.index);
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
          // Opacity tables plus room for page occupancy, counts and dirty flags.
          pools.reduce(
            (bytes, pool) =>
              bytes +
              pool.opacityBlocks.byteLength +
              pool.pageOccupancy.byteLength * 4,
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
        this.rejectFirst(error);
        this.failed(error, -1);
      }
    }
    this.changed();
  }

  private applySelection(
    prepared: RadSelectionPreparation,
    affected: Pool[],
    now: number,
  ) {
    const { selection, fade } = prepared;
    const changed = affected.length > 0;
    let index = 0;
    for (const pool of affected) {
      pool.batch.commitSelection(prepared.pools[index++]);
      if (pool.batch.numSplats > 0 && pool.batch.parent !== this.group)
        this.group.add(pool.batch);
      else if (pool.batch.numSplats === 0) pool.batch.removeFromParent();
    }
    if (fade) {
      this.transition = {
        startedAt: now,
        pools: affected,
      };
    }
    // Unchanged nodes keep the fade baseline valid for an in-flight decision.
    if (this.selection && !selection.changedChunks.length) {
      this.selection.touchedChunks = selection.touchedChunks;
      this.selection.wantedChunks = selection.wantedChunks;
    } else this.selection = selection;
    this.protectedPages = new Set(selection.touchedChunks);
    this.cancelUnusedLoads();
    if (selection.indices.length && !fade) this.resolveFirst(this);
    return changed;
  }

  private cancelUnusedLoads() {
    for (const page of this.pages.values()) {
      if (
        !this.wanted.has(page.index) &&
        !this.inFlightPages?.has(page.index) &&
        !this.readyPages?.has(page.index) &&
        !this.preparation?.pages.has(page.index) &&
        page.index !== 0
      ) {
        page.controller?.abort();
        if (page.data) this.releasePage(page);
      }
    }
  }

  private updateFade(now: number) {
    const transition = this.transition;
    if (!transition) return false;
    const progress = THREE.MathUtils.clamp(
      (now - transition.startedAt) / this.fadeDurationMs,
      0,
      1,
    );
    if (progress > 0 && this.selection?.indices.length) this.resolveFirst(this);
    if (progress === 1) {
      this.transition = undefined;
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

  private page(index: number) {
    let page = this.pages.get(index);
    if (!page) {
      const range = getRadChunkSpan(this.meta as RadMeta, index);
      page = {
        index,
        base: range.base,
        count: range.count,
        reservedBytes: 0,
        failures: 0,
        retryAt: 0,
      };
      this.pages.set(index, page);
    }
    return page;
  }

  private pump() {
    if (this.disposed || !this.meta) return;
    let loading = 0;
    let pendingBytes = 0;
    for (const page of this.pages.values()) {
      if (page.controller && !page.decoded) loading++;
      pendingBytes += page.data
        ? getSplatByteLength(page.data)
        : page.reservedBytes;
    }
    const pending = new StreamByteBudget(
      streamPendingLimit(
        this.maxConcurrentLoads,
        this.maxUploadBytesPerUpdate,
        this.maxPagePendingBytes,
      ),
      pendingBytes,
    );
    const now = performance.now();
    for (const index of this.wanted) {
      const page = this.page(index);
      if (page.pool || page.data || page.controller || now < page.retryAt)
        continue;
      if (
        loading >= this.maxConcurrentLoads ||
        !pending.reserve(this.maxPagePendingBytes)
      )
        break;
      const controller = new AbortController();
      page.controller = controller;
      page.decoded = false;
      page.reservedBytes = this.maxPagePendingBytes;
      loading++;
      void this.loader
        .loadChunk(index, controller.signal, () => {
          if (
            this.disposed ||
            controller.signal.aborted ||
            page.controller !== controller
          )
            return;
          page.decoded = true;
          this.pump();
        })
        .then((data) => {
          if (this.disposed || controller.signal.aborted) return;
          page.data = data;
          page.failures = 0;
          if (index === 0) this.setInitialBounds(data);
          this.reservePages();
        })
        .catch((error) => {
          if (!this.disposed && !controller.signal.aborted) {
            page.retryAt = performance.now() + retryDelay(page.failures++);
            this.failed(error, index);
          }
        })
        .finally(() => {
          page.controller = undefined;
          page.decoded = false;
          page.reservedBytes = 0;
          if (!this.disposed) {
            void this.requestSelection();
            this.changed();
            this.pump();
          }
        });
    }
  }

  private setInitialBounds(data: RadStreamChunk) {
    const positions = new Float32Array(
      data.splatArrays[0].buffer,
      data.splatArrays[0].byteOffset,
      data.splatArrays[0].length,
    );
    for (let index = 0; index < data.numSplats; index++) {
      this.point.set(
        positions[index * 4],
        positions[index * 4 + 1],
        positions[index * 4 + 2],
      );
      this.bounds.expandByPoint(this.point);
    }
    if (this.bounds.min.equals(this.bounds.max))
      this.bounds.expandByScalar(Math.max(0.001, data.rootRadius ?? 1));
  }

  private findSlot(): { pool: Pool; slot: number } | undefined {
    for (const pool of this.pools) {
      const slot = pool.slots.indexOf(undefined);
      if (slot !== -1) return { pool, slot };
    }
    const capacity = this.pools.reduce(
      (sum, pool) => sum + pool.slots.length,
      0,
    );
    if (capacity < this.pageBudget) {
      const pageBytes =
        getSplatTextureBytes(this.pageStride, this.numSh) + this.pageStride * 4;
      const uploadPages = Math.max(
        1,
        Math.floor(this.maxUploadBytesPerUpdate / pageBytes),
      );
      const count = Math.min(8, uploadPages, this.pageBudget - capacity);
      const batch = new RadStreamBatch({
        pageSize: this.pageSize,
        pageCount: count,
        numSh: this.numSh,
      });
      batch.layers.mask = this.group.layers.mask;
      const pool: Pool = {
        batch,
        slots: Array(count).fill(undefined),
      };
      this.pools.push(pool);
      return { pool, slot: 0 };
    }
    return undefined;
  }

  private reservePages() {
    for (const page of this.pages.values()) {
      if (!page.data || page.pool) continue;
      const available = this.findSlot();
      if (!available) continue;
      const { pool, slot } = available;
      pool.slots[slot] = page;
      page.pool = pool;
      page.slot = slot;
      this.revision++;
    }
  }

  private uploadPages() {
    const uploads = new StreamByteBudget(this.maxUploadBytesPerUpdate);
    let changed = false;
    const pages = new Set([...(this.readyPages ?? []), ...this.wanted]);
    for (const index of pages) {
      const page = this.pages.get(index);
      if (!page?.data || !page.pool) continue;
      const { pool } = page;
      const slot = page.slot as number;
      const uploadBytes = pool.batch.source.uploadBytes(
        pool.batch.source.pageStart(slot),
        this.pageStride,
      );
      if (!uploads.reserve(uploadBytes)) break;
      pool.batch.source.writePage(slot, page.data);
      page.data = undefined;
      page.expiresAt = undefined;
      changed = true;
    }
    return changed;
  }

  private releasePage(page: Page) {
    if (page.pool) {
      page.pool.batch.source.releasePage(page.slot as number);
      page.pool.slots[page.slot as number] = undefined;
      page.pool = undefined;
      page.slot = undefined;
    }
    page.data = undefined;
    page.expiresAt = undefined;
    this.loader.releaseChunk(page.index);
    this.revision++;
  }

  private releaseUnused() {
    let changed = false;
    for (const page of this.pages.values()) {
      if (!page.pool || page.index === 0) continue;
      if (
        this.protectedPages.has(page.index) ||
        this.wanted.has(page.index) ||
        page.pool.batch.source.isPageSelected(page.slot as number)
      ) {
        page.expiresAt = undefined;
        continue;
      }
      page.expiresAt ??= this.tick + this.cooldownTicks;
      // A traversal snapshot delays release without renewing unused pages.
      if (
        this.tick < page.expiresAt ||
        this.inFlightPages?.has(page.index) ||
        this.readyPages?.has(page.index) ||
        this.preparation?.pages.has(page.index)
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
  getGlobalIndex(mesh: THREE.Object3D, renderedIndex: number) {
    const pool = this.pools.find(({ batch }) => batch === mesh);
    if (!pool) throw new Error("Mesh does not belong to this RAD dataset");
    const source = pool.batch.source.getSourceIndex(renderedIndex);
    const slot = Math.floor(source / pool.batch.source.pageStride);
    const page = pool.slots[slot];
    if (!page) throw new Error("RAD raycast references a retired page");
    return page.base + source - pool.batch.source.pageStart(slot);
  }

  private changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }

  private failed(error: unknown, index: number) {
    notifyStreamError(this.options, error, this.loader.getChunkUrl(index));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const reason = new DOMException("RAD scheduler disposed", "AbortError");
    this.abort.abort(reason);
    this.rejectFirst(reason);
    for (const page of this.pages.values()) page.controller?.abort(reason);
    this.loader.dispose();
    this.preparation = undefined;
    for (const { batch } of this.pools) batch.dispose();
    this.pools.length = 0;
    this.pages.clear();
    this.wanted.clear();
    this.protectedPages.clear();
    this.inFlightPages = undefined;
    this.readyPages = undefined;
    this.selection = undefined;
    this.readySelection = undefined;
    this.reselectAfterReady = false;
    this.transition = undefined;
    this.meta = undefined;
    this.bounds.makeEmpty();
    this.views = [];
  }
}
