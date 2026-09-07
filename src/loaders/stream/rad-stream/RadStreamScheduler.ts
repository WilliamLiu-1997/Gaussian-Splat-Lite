import * as THREE from "three";
import { radPageTextureLayout } from "../../../data/RadPagedSplats";
import { getSplatTextureBytes } from "../../../data/splatData";
import type { RadChunkData, RadMeta } from "../../rad/radFormat";
import { getRadChunkByteLength, getRadChunkSpan } from "../../rad/radFormat";
import { StreamByteBudget } from "../StreamByteBudget";
import {
  type StreamSchedulerOptions,
  type StreamStats,
  notifyStreamChange,
  notifyStreamError,
  retryDelay,
  streamPendingLimit,
  streamSettings,
} from "../streamOptions";
import { RadStreamBatch } from "./RadStreamBatch";
import {
  RadStreamLoader,
  type RadStreamLoaderOptions,
} from "./RadStreamLoader";
import type { RadStreamSelection } from "./radFade";
import { type RadLodSelection, type RadLodView, radChunkIndex } from "./radLod";

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
  pool?: Pool;
  slot?: number;
  data?: RadChunkData;
  controller?: AbortController;
  reservedBytes: number;
  failures: number;
  retryAt: number;
  expiresAt?: number;
};

const EMPTY_INDICES = new Uint32Array(0);
const MIB = 1024 * 1024;

/** Camera-driven RAD tree cuts with crossfades, on-demand pages and cooldown. */
export class RadStreamScheduler {
  readonly group: THREE.Group;
  readonly initialized: Promise<this>;
  readonly firstRenderable: Promise<this>;
  readonly splatBudget: number;
  readonly cooldownTicks: number;
  readonly fadeDurationMs: number;
  readonly maxConcurrentLoads: number;
  readonly maxUploadBytesPerUpdate: number;
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
  private selection?: RadLodSelection;
  private readySelection?: RadStreamSelection;
  private transition?: {
    startedAt: number;
    hasOutgoing: boolean;
    pools: Set<Pool>;
  };
  private wanted = new Set<number>();
  private protectedPages = new Set<number>();
  private inFlightPages?: Set<number>;
  private selecting = false;
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
    this.splatBudget = settings.splatBudget;
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

  get stats(): RadStreamStats {
    const loader = this.loader.stats;
    let pendingBytes = 0;
    let residentChunks = 0;
    let loadingChunks = 0;
    for (const page of this.pages.values()) {
      if (page.pool) residentChunks++;
      if (page.controller) loadingChunks++;
      pendingBytes += page.data
        ? getRadChunkByteLength(page.data)
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
        loader.retainedTreeBytes +
        loader.estimatedCodebookBytes +
        loader.bootstrapBytes +
        loader.cachedBytes +
        (this.selection?.indices.byteLength ?? 0),
      pendingBytes,
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
      paddedCount * 12 +
      this.pageSize * 10;
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
        for (const { batch } of this.pools)
          changed = batch.setSelection(EMPTY_INDICES) || changed;
        this.selection = undefined;
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
      return {
        viewFromObject: this.matrix.elements.slice(),
        pixelScale:
          Math.max(
            Math.abs(eye.projectionMatrix.elements[0]) * width,
            Math.abs(eye.projectionMatrix.elements[5]) * height,
          ) / 2,
        orthographic:
          (eye as THREE.OrthographicCamera).isOrthographicCamera === true,
      };
    });
    const key = this.views
      .map(
        (view) =>
          `${view.viewFromObject.join(",")}/${view.pixelScale}/${view.orthographic}`,
      )
      .join(";");
    if (key !== this.lastViewKey) {
      this.lastViewKey = key;
      this.revision++;
    }
    changed = this.updateFade(now) || changed;
    // Keep at most two tree cuts visible. A completed traversal stays pinned
    // while the current crossfade finishes, then replaces the displayed cut.
    if (this.readySelection && !this.transition) {
      const selected = this.readySelection;
      this.readySelection = undefined;
      if (shown) changed = this.applySelection(selected, now) || changed;
      else this.inFlightPages = undefined;
    }
    changed = this.releaseUnused() || changed;
    if (shown) {
      changed = this.attachPages() || changed;
      this.requestSelection();
      this.pump();
    }
    if (changed) this.changed();
    return changed;
  }

  private requestSelection() {
    if (
      this.selecting ||
      this.readySelection ||
      !this.meta?.count ||
      this.lastRequestedRevision === this.revision ||
      !this.pages.get(0)?.pool
    )
      return;
    const residentChunks = [...this.pages.values()]
      .filter((page) => page.pool)
      .map((page) => page.index);
    this.inFlightPages = new Set(residentChunks);
    this.selecting = true;
    this.lastRequestedRevision = this.revision;
    const started = performance.now();
    void this.loader
      .selectLod(
        {
          views: this.views,
          splatBudget: this.splatBudget,
          pixelThreshold: 2,
          residentChunks,
          hysteresis: 0.15,
        },
        this.selection?.indices,
        this.fadeDurationMs > 0,
      )
      .then((selection) => {
        if (this.disposed) return;
        this.lodTimeMs = performance.now() - started;
        // Accept camera-lagged cuts to avoid starving continuous movement.
        // Once traversal completes, only its required pages must wait for commit.
        this.readySelection = selection;
        this.inFlightPages = new Set(selection.touchedChunks);
        this.changed();
      })
      .catch((error) => {
        if (!this.disposed) {
          this.rejectFirst(error);
          this.failed(error, -1);
        }
      })
      .finally(() => {
        this.selecting = false;
        if (!this.readySelection) this.inFlightPages = undefined;
      });
  }

  private renderSelection(
    indices: Uint32Array,
    fades?: Uint8Array,
    affected?: Set<Pool>,
  ) {
    const meta = this.meta as RadMeta;
    const selections = new Map<
      Pool,
      {
        count: number;
        ranges: { start: number; end: number; sourceOffset: number }[];
      }
    >();
    // Cuts and fade unions are sorted by file index. Resolve each page once,
    // rather than looking up pages and pools for every selected node twice.
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
      const pool = page.pool;
      if (affected && !affected.has(pool)) {
        start = end;
        continue;
      }
      const selection = selections.get(pool) ?? { count: 0, ranges: [] };
      selection.count += end - start;
      selection.ranges.push({
        start,
        end,
        sourceOffset: pool.batch.source.pageStart(page.slot) - page.base,
      });
      selections.set(pool, selection);
      start = end;
    }
    let changed = false;
    for (const pool of affected ?? this.pools) {
      const selection = selections.get(pool);
      const target = selection
        ? new Uint32Array(selection.count)
        : EMPTY_INDICES;
      const targetFades =
        fades && selection ? new Uint8Array(selection.count) : undefined;
      let offset = 0;
      for (const { start, end, sourceOffset } of selection?.ranges ?? []) {
        if (fades) targetFades?.set(fades.subarray(start, end), offset);
        for (let position = start; position < end; position++)
          target[offset++] = indices[position] + sourceOffset;
      }
      changed = pool.batch.setSelection(target, targetFades) || changed;
      if (pool.batch.numSplats > 0 && pool.batch.parent !== this.group)
        this.group.add(pool.batch);
      else if (pool.batch.numSplats === 0) pool.batch.removeFromParent();
    }
    return changed;
  }

  private applySelection(prepared: RadStreamSelection, now: number) {
    const { fade, changedChunks, ...selection } = prepared;
    const affected = new Set<Pool>();
    for (const index of changedChunks) {
      const pool = this.pages.get(index)?.pool;
      if (!pool) throw new Error("RAD transition references a retired page");
      affected.add(pool);
    }
    let changed =
      affected.size > 0 &&
      this.renderSelection(
        fade?.indices ?? selection.indices,
        fade?.fades,
        affected,
      );
    if (fade) {
      this.transition = {
        startedAt: now,
        hasOutgoing: fade.hasOutgoing,
        pools: affected,
      };
      for (const { batch } of affected)
        changed = batch.setFadeProgress(0) || changed;
    }
    this.selection = selection;
    this.protectedPages = new Set(selection.touchedChunks);
    this.wanted = new Set(selection.wantedChunks);
    this.inFlightPages = undefined;
    this.cancelUnusedLoads();
    if (selection.indices.length && !fade) this.resolveFirst(this);
    return changed;
  }

  private cancelUnusedLoads() {
    for (const page of this.pages.values()) {
      if (
        !this.wanted.has(page.index) &&
        !this.protectedPages.has(page.index) &&
        page.index !== 0
      ) {
        page.controller?.abort();
        if (page.data) {
          page.data = undefined;
          this.loader.releaseChunk(page.index);
        }
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
      if (transition.hasOutgoing) {
        return this.renderSelection(
          this.selection?.indices ?? EMPTY_INDICES,
          undefined,
          transition.pools,
        );
      }
      // Incoming-only transitions already have the final index map. Completing
      // their opacity must not rebuild indices or invalidate sort centers.
      let changed = false;
      for (const { batch } of transition.pools)
        changed = batch.finishFadeIn() || changed;
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
      if (page.controller) loading++;
      pendingBytes += page.data
        ? getRadChunkByteLength(page.data)
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
      page.reservedBytes = this.maxPagePendingBytes;
      loading++;
      void this.loader
        .loadChunk(index, controller.signal)
        .then((data) => {
          if (this.disposed || controller.signal.aborted) return;
          page.data = data;
          page.failures = 0;
          if (index === 0) this.setInitialBounds(data);
        })
        .catch((error) => {
          if (!this.disposed && !controller.signal.aborted) {
            page.retryAt = performance.now() + retryDelay(page.failures++);
            this.failed(error, index);
          }
        })
        .finally(() => {
          page.controller = undefined;
          page.reservedBytes = 0;
          if (!this.disposed) {
            this.changed();
            this.pump();
          }
        });
    }
  }

  private setInitialBounds(data: RadChunkData) {
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
      this.bounds.expandByScalar(Math.max(0.001, data.lodRadii?.[0] ?? 1));
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

  private attachPages() {
    const uploads = new StreamByteBudget(this.maxUploadBytesPerUpdate);
    let changed = false;
    for (const index of this.wanted) {
      const page = this.pages.get(index);
      if (!page?.data) continue;
      const available = this.findSlot();
      if (!available) continue;
      const { pool, slot } = available;
      const uploadBytes = pool.batch.source.uploadBytes(
        pool.batch.source.pageStart(slot),
        this.pageStride,
      );
      if (!uploads.reserve(uploadBytes)) break;
      pool.batch.source.writePage(slot, page.data);
      pool.slots[slot] = page;
      page.pool = pool;
      page.slot = slot;
      page.data = undefined;
      page.expiresAt = undefined;
      changed = true;
      this.revision++;
    }
    return changed;
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
      if (this.tick < page.expiresAt || this.inFlightPages?.has(page.index))
        continue;
      const pool = page.pool;
      pool.batch.source.releasePage(page.slot as number);
      pool.slots[page.slot as number] = undefined;
      page.pool = undefined;
      page.slot = undefined;
      page.expiresAt = undefined;
      this.loader.releaseChunk(page.index);
      this.revision++;
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
    for (const { batch } of this.pools) batch.dispose();
    this.pools.length = 0;
    this.pages.clear();
    this.wanted.clear();
    this.protectedPages.clear();
    this.inFlightPages = undefined;
    this.selection = undefined;
    this.readySelection = undefined;
    this.transition = undefined;
    this.meta = undefined;
    this.bounds.makeEmpty();
    this.views = [];
  }
}
