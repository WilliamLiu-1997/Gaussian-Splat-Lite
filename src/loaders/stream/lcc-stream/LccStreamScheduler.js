import * as THREE from "three";
import { getSplatTextureBytes } from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamCameras, streamViews } from "../StreamCameras.js";
import {
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { LccRegionPool } from "./LccRegionPool.js";
import { LccStreamLoader } from "./LccStreamLoader.js";

/** Indexed XGRIDS scenes with worker selection, shared batches and atomic crossfades. */
export class LccStreamScheduler {
  constructor(options) {
    this.options = { ...options };
    this.group = options.group ?? new THREE.Group();
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this.cooldownMs = settings.cooldownMs;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.splatBudgetMode = options.splatBudgetMode ?? "target";
    this.lodStepDistance = options.lodStepDistance ?? 20;
    this.maxScreenSpaceError = options.maxScreenSpaceError ?? 40;
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.pool = new LccRegionPool(
      this.group,
      Math.min(this.splatBudget, 262144),
    );
    this.loader = new LccStreamLoader(options, this.maxConcurrentLoads, () =>
      this.invalidate(),
    );
    this.retryTimer = new RetryTimer(() => this.invalidate());
    this.states = new Map();
    this.chunks = [];
    this.activeChunks = new Set();
    this.target = new Set();
    this.around = new Set();
    this.selectionRoots = [];
    this.priorities = new Map();
    this.displayed = new Set();
    this.fades = new Map();
    this.wanted = new Map();
    this.refinements = [];
    this.retainedNodes = new Set();
    this.coverCache = new Map();
    this.scheduleDirty = true;
    this.nextCleanupAt = Number.POSITIVE_INFINITY;
    this.selecting = false;
    this.refinementStopped = false;
    this.selectionKey = "";
    this.shown = true;
    this.disposed = false;
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.initialized = this.initialize().catch((error) => {
      this.rejectFirst(error);
      this.loader.dispose();
      throw error;
    });
    void this.firstRenderable.catch(() => {});
    void this.initialized.catch(() => {});
  }
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    this._splatBudget = positiveInteger(value, "splatBudget");
    this.selectionKey = "";
    this.changed();
  }
  get splatBudgetMode() {
    return this._splatBudgetMode;
  }
  set splatBudgetMode(value) {
    if (value !== "target" && value !== "limit")
      throw new Error('splatBudgetMode must be "target" or "limit"');
    this._splatBudgetMode = value;
    this.selectionKey = "";
    if (this.initialized) this.changed();
  }
  get lodStepDistance() {
    return this._lodStepDistance;
  }
  set lodStepDistance(value) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("lodStepDistance must be finite and positive");
    this._lodStepDistance = value;
    this.selectionKey = "";
    if (this.initialized) this.changed();
  }
  get maxScreenSpaceError() {
    return this._maxScreenSpaceError;
  }
  set maxScreenSpaceError(value) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("maxScreenSpaceError must be finite and positive");
    this._maxScreenSpaceError = value;
    this.selectionKey = "";
    if (this.initialized) this.changed();
  }
  get info() {
    return this.index?.info;
  }
  get cameras() {
    return this.streamCameras.cameras;
  }
  hasCamera(camera) {
    return this.streamCameras.has(camera);
  }
  setCamera(camera) {
    return this.streamCameras.add(camera);
  }
  deleteCamera(camera) {
    return this.streamCameras.delete(camera);
  }
  setResolution(camera, xOrVec, y) {
    return this.streamCameras.setResolution(camera, xOrVec, y);
  }
  setResolutionFromRenderer(camera, renderer) {
    return this.streamCameras.setResolutionFromRenderer(camera, renderer);
  }
  getBoundingBox() {
    const box = new THREE.Box3();
    if (this.index) {
      box.min.fromArray(this.index.sceneBounds);
      box.max.fromArray(this.index.sceneBounds, 3);
    }
    return box;
  }
  get stats() {
    const { retainedIndexBytes, ...loader } = this.loader.stats;
    const result = {
      ...loader,
      visibleSplats: 0,
      visibleNodes: 0,
      visibleMeshes: 0,
      residentMeshes: this.pool.entries.size,
      residentChunks: 0,
      residentCpuBytes: retainedIndexBytes,
      residentGpuBytes: 0,
      pendingBytes: 0,
      loadingChunks: 0,
      loadProgress: 0,
    };
    if (this.index)
      for (const value of Object.values(this.index))
        if (ArrayBuffer.isView(value))
          result.residentCpuBytes += value.byteLength;
    for (const { batch } of this.pool.entries) {
      result.residentCpuBytes += batch.source.getByteLength();
      result.residentGpuBytes += batch.source.textureByteLength;
      if (this.shown && batch.numSplats) {
        result.visibleMeshes++;
        result.visibleSplats += batch.numSplats;
      }
    }
    for (const state of this.states.values()) {
      if (this.shown && Math.fround(state.region?.opacity ?? 0) > 0)
        result.visibleNodes++;
      result.pendingBytes += state.pending?.bytes ?? 0;
    }
    for (const id of this.activeChunks) {
      const chunk = this.chunks[id];
      if (chunk.source?.alive) {
        result.residentChunks++;
        result.residentCpuBytes += chunk.source.info.byteLength;
      }
      if (chunk.controller) result.loadingChunks++;
    }
    if (this.index) {
      let count = this.target.size;
      let ready = 0;
      for (const node of this.target) if (this.displayed.has(node)) ready++;
      if (this.environment !== undefined) {
        count++;
        if (
          this.displayed.has(-1) ||
          this.chunks[this.environment].file.count === 0
        )
          ready++;
      }
      result.loadProgress = count
        ? ready / count
        : !this.empty && !this.selectionReady
          ? 0
          : 1;
    }
    result.residentBytes = result.residentCpuBytes + result.residentGpuBytes;
    return result;
  }
  async initialize() {
    const index = await this.loader.initialize(this.abort.signal);
    this.abort.signal.throwIfAborted();
    this.index = index;
    this.empty = index.empty;
    this.chunks = index.chunks.map((file) => ({
      file,
      failures: 0,
      retryAt: 0,
    }));
    if (this.options.environment !== false)
      this.environment = index.environment;
    if (this.empty && this.environment === undefined) this.resolveFirst(this);
    this.changed();
    return this;
  }
  captureView(cameras) {
    this.group.updateWorldMatrix(true, false);
    let shown = cameras.length > 0;
    for (let object = this.group; object; object = object.parent)
      shown &&= object.visible;
    const views = streamViews(cameras).map((camera) => {
      const height =
        camera.viewport?.w ?? this.streamCameras.getResolution(camera)?.y;
      if (this.index.format === "lcc2" && height === undefined)
        throw new Error(
          "LCC2 camera needs setResolution() or setResolutionFromRenderer()",
        );
      return {
        modelView: new THREE.Matrix4()
          .copy(camera.matrixWorld)
          .invert()
          .multiply(this.group.matrixWorld).elements,
        projection: camera.projectionMatrix.toArray(),
        coordinateSystem: camera.coordinateSystem,
        reversedDepth: camera.reversedDepth,
        height: height ?? 1,
      };
    });
    return { shown, cameras: views };
  }
  update() {
    if (this.disposed) return false;
    const cameras = this.streamCameras.seeing(this.group.layers);
    if (!this.index) return false;
    const view = this.captureView(cameras);
    if (view.shown && !view.cameras.length) return false;
    this.view = view;
    if (this.shown !== view.shown) this.scheduleDirty = true;
    this.shown = view.shown;
    for (const { batch } of this.pool.entries)
      batch.layers.mask = this.group.layers.mask;
    const now = performance.now();
    let changed = this.updateFades(now);
    if (this.refinementStopped) {
      if (this.scheduleDirty || now >= this.nextCleanupAt) {
        this.scheduleDirty = false;
        this.releaseUnused(now);
      }
      if (changed) this.changed();
      return changed;
    }
    if (this.scheduleDirty) {
      this.scheduleDirty = false;
      if (!view.shown) {
        this.target.clear();
        this.around.clear();
        this.priorities.clear();
        this.selectionKey = "";
      }
      this.wanted.clear();
      this.refinements.length = 0;
      this.retainedNodes.clear();
      this.coverCache.clear();
      this.coverageError = undefined;
      const next = [];
      if (this.shown) {
        if (this.index.format === "lcc")
          for (const node of this.target) this.coverUnit(node, next);
        else for (const root of this.selectionRoots) this.cover(root, next);
        if (this.environment !== undefined) {
          if (this.ready(-1)) next.push(-1);
          else this.want(-1);
        }
      }
      // Establish missing coverage before preparing detail.
      this.refinements.sort(
        (a, b) => this.priorities.get(a) - this.priorities.get(b),
      );
      for (const node of this.refinements) this.want(node);
      // Resident coarse coverage around the camera loads last.
      for (const node of this.around) if (!this.ready(node)) this.want(node);
      for (const node of next) this.retainedNodes.add(node);
      changed = this.publish(next, now) || changed;
      changed = this.updateFades(now) || changed;
      this.releaseUnused(now);
      this.pump(now);
    } else if (now >= this.nextCleanupAt) this.releaseUnused(now);
    void this.requestSelection();
    this.checkFirstRenderable();
    if (changed) this.changed();
    return changed;
  }
  async requestSelection() {
    if (
      this.disposed ||
      this.refinementStopped ||
      this.selecting ||
      !this.view?.shown
    )
      return;
    const environmentCount =
      this.environment === undefined
        ? 0
        : Math.max(0, this.chunks[this.environment].file.count);
    const request = {
      view: this.view,
      budget: Math.max(0, this.splatBudget - environmentCount),
      splatBudgetMode: this.splatBudgetMode,
      lodStepDistance: this.lodStepDistance,
      maxScreenSpaceError: this.maxScreenSpaceError,
    };
    const key = JSON.stringify(request);
    if (key === this.selectionKey) return;
    this.selectionKey = key;
    this.selecting = true;
    try {
      const { nodes: result, around } = await this.loader.selectLod(request);
      if (this.disposed || !this.shown) return;
      if (
        request.budget !== Math.max(0, this.splatBudget - environmentCount) ||
        request.splatBudgetMode !== this.splatBudgetMode ||
        request.lodStepDistance !== this.lodStepDistance ||
        request.maxScreenSpaceError !== this.maxScreenSpaceError
      )
        return;
      this.target = new Set(result);
      this.around = new Set(around);
      this.selectionReady = true;
      this.priorities.clear();
      const roots = new Set();
      for (const [priority, node] of result.entries()) {
        this.priorities.set(node, priority);
        let root = node;
        for (
          let parent = this.index.parents[node];
          parent >= 0;
          parent = this.index.parents[parent]
        ) {
          if (!this.priorities.has(parent))
            this.priorities.set(parent, priority);
          root = parent;
        }
        roots.add(root);
      }
      this.selectionRoots = [...roots];
      this.invalidate();
    } catch (error) {
      this.stopRefinement(error);
    } finally {
      this.selecting = false;
      void this.requestSelection();
    }
  }
  state(node) {
    let state = this.states.get(node);
    if (!state) {
      state = { node };
      this.states.set(node, state);
    }
    return state;
  }
  chunkFor(node) {
    return node < 0 ? this.environment : this.index.chunk[node];
  }
  count(node) {
    return node < 0
      ? this.chunks[this.environment].file.count
      : this.index.counts[node];
  }
  ready(node) {
    return this.count(node) === 0 || !!this.states.get(node)?.region;
  }
  want(node, refinement = false) {
    if (refinement) {
      this.refinements.push(node);
      return;
    }
    const id = this.chunkFor(node);
    let nodes = this.wanted.get(id);
    if (!nodes) {
      nodes = new Set();
      this.wanted.set(id, nodes);
    }
    nodes.add(node);
  }
  /** Reuse any complete resident cut, including hidden and cooling regions. */
  cachedCover(node) {
    if (this.coverCache.has(node)) return this.coverCache.get(node);
    let cover;
    if (this.ready(node)) cover = [node];
    else if (this.index.childCount[node]) {
      cover = [];
      for (const child of this.children(node)) {
        const cached = this.cachedCover(child);
        if (!cached) {
          cover = undefined;
          break;
        }
        cover.push(...cached);
      }
    }
    this.coverCache.set(node, cover);
    return cover;
  }
  *children(node) {
    const { firstChild, childCount } = this.index;
    for (
      let child = firstChild[node];
      child < firstChild[node] + childCount[node];
      child++
    )
      yield child;
  }
  /** LCC LODs replace the same Unit; they are not spatial parent/child tiles. */
  coverUnit(node, output) {
    if (this.ready(node)) {
      output.push(node);
      return;
    }
    const { levels, counts, level } = this.index;
    const root = node - (node % levels);
    // Nodes run from coarse to fine. A displayed finer LOD stays while the
    // Unit coarsens; otherwise show the finest ready LOD up to the target.
    let coarse;
    let coarser;
    let finer;
    for (let candidate = root; candidate < root + levels; candidate++) {
      if (counts[candidate] < 50) continue;
      coarse ??= candidate;
      if (!this.ready(candidate)) continue;
      if (candidate < node) coarser = candidate;
      else if (finer === undefined || this.displayed.has(candidate))
        finer = candidate;
    }
    const shown =
      finer !== undefined &&
      (this.displayed.has(finer) || coarser === undefined)
        ? finer
        : coarser;
    if (shown === undefined) {
      this.want(coarse);
      return;
    }
    output.push(shown);
    let next = node;
    // Like SOG, split refinements of four or more levels at their midpoint.
    if (shown < node && level[shown] - level[node] >= 4) {
      next = root + levels - 1 - Math.floor((level[shown] + level[node]) / 2);
      while (next < node && counts[next] < 50) next++;
    }
    this.want(next, true);
  }
  /** A spatial parent is replaced only by a complete resident child cut. */
  cover(node, output, refinement = false) {
    if (!this.priorities.has(node)) return true;
    const cached = this.cachedCover(node);
    if (!cached) {
      if (refinement) this.wantRefinement(node);
      else this.want(node);
      return false;
    }
    if (!this.target.has(node)) {
      // A permanently missing sibling makes this replacement impossible.
      // Keep coarse coverage and let unused prepared siblings expire.
      const blocked = [...this.children(node)].find(
        (child) =>
          !this.cachedCover(child) &&
          this.chunks[this.chunkFor(child)].retryAt ===
            Number.POSITIVE_INFINITY,
      );
      if (blocked !== undefined)
        this.coverageError ??= this.chunks[this.chunkFor(blocked)].error;
      else {
        const start = output.length;
        let complete = true;
        for (const child of this.children(node))
          complete = this.cover(child, output, true) && complete;
        if (complete) return true;
        for (let i = start; i < output.length; i++)
          this.retainedNodes.add(output[i]);
        output.length = start;
      }
    } else if (!this.ready(node)) this.want(node, true);
    output.push(...cached);
    return true;
  }
  /**
   * Request the next cover of a node that refines a displayed parent. Virtual
   * preview levels step one level. Otherwise the parent is replaced by its
   * target cut, or first by the cut halfway there when that is four or more
   * levels finer, as SOG splits its gaps.
   */
  wantRefinement(node) {
    const { level, maxLod } = this.index;
    const parent = this.index.parents[node];
    const from = parent < 0 ? level[node] : level[parent];
    if (from > maxLod) return this.want(node, true);
    let finest = level[node];
    const visit = (current) => {
      if (this.target.has(current) || !this.index.childCount[current])
        finest = Math.min(finest, level[current]);
      else for (const child of this.children(current)) visit(child);
    };
    visit(node);
    const stop = from - finest >= 4 ? Math.floor((from + finest) / 2) : -1;
    const cut = (current) => {
      if (
        this.target.has(current) ||
        level[current] <= stop ||
        !this.index.childCount[current]
      ) {
        const cover = this.cachedCover(current);
        // Keep prepared parts of an incomplete cut until it can replace its parent.
        if (cover)
          for (const prepared of cover) this.retainedNodes.add(prepared);
        else this.want(current, true);
      } else for (const child of this.children(current)) cut(child);
    };
    cut(node);
  }
  contains(ancestor, node) {
    for (
      let current = node;
      current >= 0;
      current = this.index.parents[current]
    )
      if (current === ancestor) return true;
    return ancestor === node;
  }
  publish(nodes, now) {
    const next = new Set(nodes);
    const changes = new Set();
    for (const node of this.displayed) if (!next.has(node)) changes.add(node);
    for (const node of next) if (!this.displayed.has(node)) changes.add(node);
    const groups = new Map();
    for (const node of changes) {
      let root = node;
      for (
        let parent = node < 0 ? -1 : this.index.parents[node];
        parent >= 0;
        parent = this.index.parents[parent]
      )
        if (changes.has(parent)) root = parent;
      const group = groups.get(root) ?? [];
      group.push(node);
      groups.set(root, group);
    }
    let changed = false;
    for (const [root, group] of groups) {
      // Only overlapping transitions wait. Other Units and spatial branches
      // can publish while this replacement finishes its fade. A region's own
      // visibility fade can reverse without waiting for it to disappear.
      if (
        [...this.fades.keys()].some(
          (node) =>
            (group.length !== 1 || node !== root) &&
            (this.contains(root, node) || this.contains(node, root)),
        )
      )
        continue;
      for (const node of group) {
        this.fade(node, next.has(node) ? 1 : 0, now);
        if (next.has(node)) this.displayed.add(node);
        else this.displayed.delete(node);
      }
      changed = true;
    }
    return changed;
  }
  fade(node, to, now) {
    const region = this.states.get(node)?.region;
    if (region && region.opacity !== to)
      this.fades.set(node, { from: region.opacity, to, startedAt: now });
    else this.fades.delete(node);
  }
  updateFades(now) {
    let changed = false;
    for (const [node, fade] of this.fades) {
      const region = this.states.get(node).region;
      const progress =
        this.fadeDurationMs === 0
          ? 1
          : Math.min(1, (now - fade.startedAt) / this.fadeDurationMs);
      const opacity = THREE.MathUtils.lerp(fade.from, fade.to, progress);
      if (region.opacity !== opacity) {
        region.opacity = opacity;
        region.batch.setRegionOpacity(region.start, opacity);
        changed = true;
      }
      if (progress === 1) {
        this.fades.delete(node);
        this.scheduleDirty = true;
      }
    }
    return changed;
  }
  pump(now) {
    if (this.disposed || this.refinementStopped) return;
    let loading = 0;
    for (const id of this.activeChunks) {
      const chunk = this.chunks[id];
      if (chunk.source && !chunk.source.alive) {
        chunk.source.dispose();
        chunk.source = undefined;
      }
      if (chunk.controller) {
        loading++;
        if (!this.wanted.has(id)) chunk.controller.abort();
      }
    }
    for (const [id, nodes] of this.wanted) {
      const chunk = this.chunks[id];
      if (now < chunk.retryAt) continue;
      if (chunk.source?.alive) this.extract(chunk, nodes);
      else if (!chunk.controller && loading < this.maxConcurrentLoads) {
        const controller = new AbortController();
        chunk.controller = controller;
        this.activeChunks.add(id);
        loading++;
        void this.load(chunk, controller);
      }
    }
    this.retryTimer.update(
      [...this.wanted.keys()].map((id) => this.chunks[id].retryAt),
    );
  }
  async load(chunk, controller) {
    let source;
    try {
      source = await this.loader.load(chunk.file, controller.signal);
      controller.signal.throwIfAborted();
      if (chunk.file.environment) chunk.file.count = source.info.numSplats;
      chunk.source = source;
      source = undefined;
      chunk.failures = 0;
      chunk.retryAt = 0;
      if (this.empty && chunk.file.environment && !chunk.file.count)
        this.resolveFirst(this);
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed)
        this.chunkFailed(chunk, error);
    } finally {
      source?.dispose();
      chunk.controller = undefined;
      this.invalidate();
    }
  }
  extract(chunk, nodes) {
    const pending = [];
    for (const node of nodes) {
      if (this.ready(node)) continue;
      const state = this.state(node);
      if (state.pending) continue;
      const item = {
        node,
        bytes: getSplatTextureBytes(this.count(node), chunk.source.info.numSh),
      };
      state.pending = item;
      pending.push(item);
    }
    if (!pending.length) return;
    const source = chunk.source;
    const ranges = pending.map(({ node }) => ({
      start: node < 0 ? 0 : this.index.start[node],
      count: this.count(node),
    }));
    void source
      .extract(ranges)
      .then((results) => {
        if (this.disposed || this.refinementStopped) return;
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          const state = this.states.get(item.node);
          if (state?.pending !== item) continue;
          state.pending = undefined;
          if (!this.wanted.get(this.chunkFor(item.node))?.has(item.node))
            continue;
          try {
            state.region = this.pool.allocate(results[i]);
          } catch (error) {
            this.chunkFailed(chunk, error);
          }
        }
      })
      .catch((error) => {
        if (!this.disposed && !this.refinementStopped)
          this.chunkFailed(chunk, error);
      })
      .finally(() => {
        for (const item of pending) {
          const state = this.states.get(item.node);
          if (state?.pending === item) state.pending = undefined;
        }
        this.invalidate();
      });
  }
  chunkFailed(chunk, error) {
    chunk.retryAt = streamRetryAt(error, chunk.failures++);
    chunk.error = error;
    this.scheduleDirty = true;
    this.failed(error, chunk.file.url);
  }
  checkFirstRenderable() {
    if (
      this.shown &&
      [...this.states.values()].some(({ region }) => (region?.opacity ?? 0) > 0)
    ) {
      this.resolveFirst(this);
      return;
    }
    if (
      this.empty &&
      (this.environment === undefined || this.count(-1) === 0)
    ) {
      this.resolveFirst(this);
      return;
    }
    // Reevaluate after successes too: an optional environment can resolve
    // empty after every scene chunk has already failed permanently.
    if (this.selecting || (!this.selectionReady && !this.empty)) return;
    if ([...this.displayed].some((node) => this.states.get(node)?.region))
      return;
    if (
      (this.wanted.size || this.coverageError) &&
      [...this.wanted.keys()].every(
        (id) => this.chunks[id].retryAt === Number.POSITIVE_INFINITY,
      )
    )
      this.rejectFirst(
        this.coverageError ??
          this.chunks[this.wanted.keys().next().value].error,
      );
  }
  releaseUnused(now) {
    this.nextCleanupAt = Number.POSITIVE_INFINITY;
    const referenced = new Set(this.wanted.keys());
    for (const [node, state] of this.states) {
      const chunk = this.chunkFor(node);
      if (state.pending) referenced.add(chunk);
      const used =
        this.displayed.has(node) ||
        this.fades.has(node) ||
        this.retainedNodes.has(node) ||
        this.wanted.get(chunk)?.has(node) ||
        state.pending;
      if (used || this.around.has(node)) {
        state.expiresAt = undefined;
        if (used && this.index.format === "lcc2") referenced.add(chunk);
        continue;
      }
      state.expiresAt ??= now + this.cooldownMs;
      if (now >= state.expiresAt) {
        if (state.region) this.pool.release(state.region);
        this.states.delete(node);
      } else this.nextCleanupAt = Math.min(this.nextCleanupAt, state.expiresAt);
    }
    for (const id of this.activeChunks) {
      const chunk = this.chunks[id];
      if (referenced.has(id) || chunk.controller) {
        chunk.expiresAt = undefined;
        continue;
      }
      chunk.expiresAt ??= now + this.cooldownMs;
      if (now >= chunk.expiresAt) {
        chunk.source?.dispose();
        chunk.source = undefined;
        this.activeChunks.delete(id);
      } else this.nextCleanupAt = Math.min(this.nextCleanupAt, chunk.expiresAt);
    }
  }
  invalidate() {
    this.scheduleDirty = true;
    this.changed();
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, url) {
    notifyStreamError(this.options, error, url);
  }
  stopRefinement(error) {
    if (this.disposed || this.refinementStopped) return;
    this.refinementStopped = true;
    this.retryTimer.dispose();
    this.wanted.clear();
    this.around.clear();
    this.refinements.length = 0;
    this.retainedNodes.clear();
    this.coverCache.clear();
    for (const state of this.states.values()) state.pending = undefined;
    for (const id of this.activeChunks) {
      const chunk = this.chunks[id];
      chunk.controller?.abort(error);
      chunk.source?.dispose();
      chunk.source = undefined;
    }
    this.loader.dispose();
    this.scheduleDirty = true;
    this.rejectFirst(error);
    this.failed(error, this.options.url);
    this.changed();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.rejectFirst(this.abort.signal.reason);
    this.retryTimer.dispose();
    for (const chunk of this.chunks) {
      chunk.controller?.abort();
      chunk.source?.dispose();
    }
    this.loader.dispose();
    this.pool.dispose();
    this.chunks = [];
    this.activeChunks.clear();
    this.states.clear();
    this.target.clear();
    this.around.clear();
    this.selectionRoots = [];
    this.priorities.clear();
    this.displayed.clear();
    this.fades.clear();
    this.wanted.clear();
    this.refinements.length = 0;
    this.retainedNodes.clear();
    this.coverCache.clear();
    this.index = undefined;
    this.view = undefined;
  }
}
