import * as THREE from "three";
import {
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamCameras } from "../StreamCameras.js";
import {
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamRetryAt,
  streamSettings,
} from "../streamOptions.js";
import { captureStreamView, getStreamViewKey } from "../streamView.js";
import { LccRegionPool } from "./LccRegionPool.js";
import { LccStreamLoader } from "./LccStreamLoader.js";
const EMPTY_CUT = new Uint32Array(0);
const ENVIRONMENT = -1;
// Writing copies packed records and uploads their texture layers. Spread large
// regions over several updates; a region shows only once fully written.
const WRITE_SPLATS_PER_UPDATE = 1 << 18;
// Load an intermediate level first when the target is this many levels finer.
const PROGRESSIVE_LEVELS = 4;
/** Camera-driven XGRIDS LCC and LCC2 streaming with per-node fades. */
export class LccStreamScheduler {
  constructor(options) {
    this.options = { ...options };
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.group = options.group ?? new THREE.Group();
    const settings = streamSettings(options);
    this._splatBudget = settings.splatBudget;
    this.splatBudgetMode = options.splatBudgetMode ?? "target";
    this.lodBaseDistance = options.lodBaseDistance ?? 100;
    this.lodMultiplier = options.lodMultiplier ?? 2;
    this.cooldownMs = settings.cooldownMs;
    this.fadeDurationMs = settings.fadeDurationMs;
    this.maxConcurrentLoads = settings.maxConcurrentLoads;
    this.showEnvironment = options.environment ?? true;
    this.disposed = false;
    this.shown = true;
    this.selecting = false;
    this.lastRequestedKey = "";
    this.boundsVersion = 0;
    this.boundsUpdates = [];
    // Node ID to its display state, loaded region and pending data.
    this.nodes = new Map();
    this.shownNodes = new Set();
    this.arrivals = new Set();
    this.fades = new Map();
    this.cut = EMPTY_CUT;
    this.target = new Set();
    this.above = new Set();
    this.units = new Map();
    this.wanted = new Map();
    this.wantedNodes = new Set();
    this.dirty = true;
    this.retryTimer = new RetryTimer(() => this.changed());
    this.pool = new LccRegionPool(
      this.group,
      Math.min(Math.max(this.splatBudget >> 1, 1 << 18), 1 << 21),
    );
    this.loader = new LccStreamLoader(
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
      this.dispose();
      throw error;
    });
    // Both readiness promises are optional to observe; load failures also
    // reach onError.
    void this.initialized.catch(() => {});
    void this.firstRenderable.catch(() => {});
  }
  /** Splat budget, including the environment. Reassign to reselect detail. */
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    if (value === this._splatBudget) return;
    this._splatBudget = positiveInteger(value, "splatBudget");
    void this.requestSelection();
  }
  /** Fill the budget, or limit detail to the configured distance bands. */
  get splatBudgetMode() {
    return this._splatBudgetMode;
  }
  set splatBudgetMode(value) {
    if (value === this._splatBudgetMode) return;
    if (value !== "target" && value !== "limit")
      throw new Error('splatBudgetMode must be "target" or "limit"');
    this._splatBudgetMode = value;
    void this.requestSelection();
  }
  /** Base LOD distance in world units for limit mode. Higher retains more detail. */
  get lodBaseDistance() {
    return this._lodBaseDistance;
  }
  set lodBaseDistance(value) {
    if (value === this._lodBaseDistance) return;
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("lodBaseDistance must be finite and positive");
    this._lodBaseDistance = value;
    void this.requestSelection();
  }
  /** Distance multiplier between LOD levels; affects both budget modes. */
  get lodMultiplier() {
    return this._lodMultiplier;
  }
  set lodMultiplier(value) {
    if (value === this._lodMultiplier) return;
    if (!Number.isFinite(value) || value < 1)
      throw new Error("lodMultiplier must be finite and at least 1");
    this._lodMultiplier = value;
    void this.requestSelection();
  }
  /** Scene metadata from the manifest; available after initialized resolves. */
  get info() {
    return this.table?.info;
  }
  get stats() {
    const { retainedIndexBytes, ...loaderStats } = this.loader.stats;
    const stats = {
      visibleSplats: 0,
      visibleMeshes: 0,
      visibleRegions: 0,
      residentMeshes: this.pool.entries.size,
      residentChunks: 0,
      residentCpuBytes: retainedIndexBytes,
      residentGpuBytes: 0,
      pendingBytes: 0,
      loadingChunks: 0,
      loadProgress: this.table ? 1 : 0,
      ...loaderStats,
    };
    for (const { batch } of this.pool.entries) {
      stats.residentCpuBytes += batch.source.getByteLength();
      stats.residentGpuBytes += batch.source.textureByteLength;
      if (this.shown && batch.numSplats > 0) {
        stats.visibleMeshes++;
        stats.visibleSplats += batch.numSplats;
      }
    }
    for (const state of this.allStates()) {
      if (state.region) {
        stats.residentChunks++;
        if (this.shown && Math.fround(state.region.opacity) > 0)
          stats.visibleRegions++;
      }
      if (state.data) stats.pendingBytes += getSplatByteLength(state.data);
    }
    for (const unit of this.units.values()) {
      if (unit.controller) stats.loadingChunks++;
      if (unit.source?.alive)
        stats.residentCpuBytes += unit.source.info.byteLength;
    }
    if (this.table && this.shown) {
      let wanted = 0;
      let ready = 0;
      for (const node of this.cut) {
        wanted++;
        if (this.nodes.get(node)?.shown) ready++;
      }
      if (this.environment?.count !== 0 && this.environment) {
        wanted++;
        if (this.environment.state.shown) ready++;
      }
      stats.loadProgress =
        this.table.nodeCount && this.cut === EMPTY_CUT
          ? 0
          : wanted
            ? ready / wanted
            : 1;
    }
    stats.residentBytes = stats.residentCpuBytes + stats.residentGpuBytes;
    return stats;
  }
  /** Group-local scene bounds from the manifest; available after initialized resolves. */
  getBoundingBox() {
    const box = new THREE.Box3();
    if (this.table) {
      box.min.fromArray(this.table.sceneBounds, 0);
      box.max.fromArray(this.table.sceneBounds, 3);
    }
    return box;
  }
  async initialize() {
    const table = await this.loader.initialize(this.abort.signal);
    this.abort.signal.throwIfAborted();
    this.table = table;
    this.shownBelow = new Uint32Array(table.nodeCount);
    if (this.showEnvironment) {
      if (table.format === "lcc")
        this.environment = {
          state: { node: ENVIRONMENT, shown: false },
          unit: this.unit("environment", { kind: "environment" }),
          count: undefined,
        };
      else if (table.environmentFile !== undefined)
        this.environment = {
          state: { node: ENVIRONMENT, shown: false },
          unit: this.unit(`file:${table.environmentFile}`, {
            kind: "file",
            file: table.environmentFile,
          }),
          count: table.environmentCount,
        };
    }
    let total = 0;
    for (const count of table.count) total += count;
    if (!total && !this.environment) this.resolveFirst(this);
    this.dirty = true;
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
   * Select detail for this camera on each update. Detail follows distance, so
   * it needs no resolution. For WebXR register renderer.xr.getCamera(): each
   * node follows the nearest eye that sees it. Returns whether the camera was
   * newly added.
   */
  setCamera(camera) {
    return this.streamCameras.add(camera);
  }
  /** Stop selecting detail for this camera. Returns whether it was registered. */
  deleteCamera(camera) {
    return this.streamCameras.delete(camera);
  }
  /** Call before rendering. Returns whether the displayed data changed. */
  update() {
    if (this.disposed) return false;
    const cameras = this.streamCameras.seeing(this.group.layers);
    if (!this.table) return false;
    this.pool.setLayers(this.group.layers.mask);
    const view = captureStreamView(cameras, this.group);
    // Three can register the XR rig before it supplies the first eye poses.
    // Keep the displayed detail and loads until those poses arrive.
    if (view.shown && !view.cameras.length) return false;
    this.view = view;
    if (view.shown !== this.shown) {
      this.shown = view.shown;
      this.lastRequestedKey = "";
      if (!view.shown) this.setCut(EMPTY_CUT);
    }
    const now = performance.now();
    let changed = this.updateFades(now);
    changed = this.writeArrivals() || changed;
    if (this.dirty) changed = this.resolve(now) || changed;
    // Complete zero-duration fades in this update as well.
    changed = this.updateFades(now) || changed;
    void this.requestSelection();
    this.pump(now);
    this.releaseUnused(now, !this.shown || !this.selecting);
    if (changed) this.changed();
    return changed;
  }
  async requestSelection() {
    const view = this.view;
    if (
      this.disposed ||
      !this.shown ||
      this.selecting ||
      !this.table?.nodeCount ||
      !view
    )
      return;
    const splatBudget = this.splatBudget;
    const splatBudgetMode = this.splatBudgetMode;
    const lodBaseDistance = this.lodBaseDistance;
    const lodMultiplier = this.lodMultiplier;
    const budget = Math.max(0, splatBudget - (this.environment?.count ?? 0));
    if (this.boundsUpdates.length) {
      this.loader.setBounds(this.boundsUpdates);
      this.boundsUpdates = [];
      this.boundsVersion++;
    }
    const key = `${getStreamViewKey(view)}/${budget}/${splatBudgetMode}/${lodBaseDistance}/${lodMultiplier}/${this.boundsVersion}`;
    if (key === this.lastRequestedKey) return;
    this.lastRequestedKey = key;
    this.selecting = true;
    try {
      const cut = await this.loader.selectLod({
        view,
        budget,
        splatBudgetMode,
        lodBaseDistance,
        lodMultiplier,
      });
      if (
        this.disposed ||
        !this.shown ||
        splatBudget !== this.splatBudget ||
        splatBudgetMode !== this.splatBudgetMode ||
        lodBaseDistance !== this.lodBaseDistance ||
        lodMultiplier !== this.lodMultiplier
      )
        return;
      // Keep one completed result; accepting camera lag avoids starving motion.
      this.setCut(cut);
      const now = performance.now();
      this.resolve(now);
      this.pump(now);
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
  setCut(cut) {
    const parent = this.table.parent;
    this.cut = cut;
    this.target = new Set(cut);
    this.above = new Set();
    for (const node of cut)
      for (
        let ancestor = parent[node];
        ancestor >= 0;
        ancestor = parent[ancestor]
      ) {
        if (this.above.has(ancestor)) break;
        this.above.add(ancestor);
      }
    this.dirty = true;
  }
  *allStates() {
    yield* this.nodes.values();
    if (this.environment) yield this.environment.state;
  }
  state(node) {
    if (node === ENVIRONMENT) return this.environment.state;
    let state = this.nodes.get(node);
    if (!state) {
      state = { node, shown: false };
      this.nodes.set(node, state);
    }
    return state;
  }
  count(node) {
    return node === ENVIRONMENT
      ? (this.environment.count ?? 1)
      : this.table.count[node];
  }
  /** Data that can be shown now; empty nodes need no data. */
  ready(node) {
    if (this.count(node) === 0) return true;
    const state =
      node === ENVIRONMENT ? this.environment.state : this.nodes.get(node);
    return !!state?.region;
  }
  isShown(node) {
    return !!this.nodes.get(node)?.shown;
  }
  rootOf(node) {
    const parent = this.table.parent;
    let root = node;
    while (parent[root] >= 0) root = parent[root];
    return root;
  }
  /**
   * The nodes that show `node`'s region at the cut where their data is ready.
   * A node stays in place until every part of its replacement is ready, so a
   * refinement or coarsening never opens a hole; cached intermediate levels
   * are used on the way. Returns undefined when nothing ready covers it.
   */
  cover(node, output) {
    if (!this.target.has(node)) {
      const { table } = this;
      const length = output.length;
      const first = table.firstChild[node];
      let complete = true;
      for (let child = first; child < first + table.childCount[node]; child++)
        if (this.target.has(child) || this.above.has(child))
          complete &&= this.cover(child, output);
      if (complete) return true;
      output.length = length;
    }
    if (!this.ready(node)) return this.coverShown(node, output);
    output.push(node);
    return true;
  }
  /** The currently shown nodes that cover `node`'s region, if they do. */
  coverShown(node, output) {
    if (this.isShown(node)) {
      output.push(node);
      return true;
    }
    if (!this.shownBelow[node]) return false;
    const { table } = this;
    const length = output.length;
    const first = table.firstChild[node];
    for (let child = first; child < first + table.childCount[node]; child++)
      if (!this.coverShown(child, output)) {
        output.length = length;
        return false;
      }
    return true;
  }
  /** Switch regions to the best ready cover of the current cut, then choose loads. */
  resolve(now) {
    this.dirty = false;
    const { table } = this;
    const desired = new Set();
    const kept = new Set();
    const output = [];
    for (const root of table.roots) {
      if (!this.target.has(root) && !this.above.has(root)) continue;
      output.length = 0;
      if (this.cover(root, output))
        for (const node of output) desired.add(node);
      else kept.add(root);
    }
    let changed = false;
    for (const node of [...this.shownNodes]) {
      if (desired.has(node)) continue;
      if (kept.has(this.rootOf(node))) continue;
      changed = this.setShown(node, false, now) || changed;
    }
    for (const node of desired)
      changed = this.setShown(node, true, now) || changed;
    const environment = this.environment;
    if (environment)
      changed =
        this.setShown(
          ENVIRONMENT,
          this.shown && this.ready(ENVIRONMENT) && environment.count !== 0,
          now,
        ) || changed;
    this.chooseLoads();
    return changed;
  }
  setShown(node, shown, now) {
    const state = this.state(node);
    if (state.shown === shown) return false;
    state.shown = shown;
    if (node !== ENVIRONMENT) {
      if (shown) this.shownNodes.add(node);
      else this.shownNodes.delete(node);
      const parent = this.table.parent;
      for (
        let ancestor = parent[node];
        ancestor >= 0;
        ancestor = parent[ancestor]
      )
        this.shownBelow[ancestor] += shown ? 1 : -1;
    }
    if (state.region) this.fadeRegion(state.region, shown, now);
    return true;
  }
  /**
   * Missing data for the cut, in priority order. Regions with nothing on
   * screen load their coarsest data first; large refinements load an
   * intermediate level first.
   */
  chooseLoads() {
    const { table } = this;
    const { parent, level } = table;
    const coverage = [];
    const refinement = [];
    if (this.environment && this.shown && !this.ready(ENVIRONMENT))
      coverage.push(ENVIRONMENT);
    for (const node of this.cut) {
      if (this.ready(node)) continue;
      let anchor = -1;
      for (
        let ancestor = parent[node];
        ancestor >= 0;
        ancestor = parent[ancestor]
      )
        if (this.isShown(ancestor) || this.ready(ancestor)) {
          anchor = ancestor;
          break;
        }
      if (anchor < 0 && !this.shownBelow[node]) {
        const root = this.rootOf(node);
        coverage.push(this.ready(root) ? node : root);
        continue;
      }
      let load = node;
      if (anchor >= 0 && level[anchor] - level[node] >= PROGRESSIVE_LEVELS) {
        const middle = (level[anchor] + level[node]) >> 1;
        while (parent[load] !== anchor && level[load] < middle)
          load = parent[load];
        if (this.ready(load)) load = node;
      }
      refinement.push(load);
    }
    this.wanted = new Map();
    this.wantedNodes = new Set();
    for (const node of [...coverage, ...refinement]) {
      if (this.wantedNodes.has(node)) continue;
      this.wantedNodes.add(node);
      // Arrived data is still being written; extraction is in flight.
      const state =
        node === ENVIRONMENT ? this.environment.state : this.nodes.get(node);
      if (state?.data || state?.extracting) continue;
      const unit = this.unitFor(node);
      if (!this.wanted.has(unit)) this.wanted.set(unit, []);
      this.wanted.get(unit).push(node);
    }
  }
  unit(key, properties) {
    let unit = this.units.get(key);
    if (!unit) {
      unit = { key, failures: 0, retryAt: 0, ...properties };
      this.units.set(key, unit);
    }
    return unit;
  }
  unitFor(node) {
    if (node === ENVIRONMENT) return this.environment.unit;
    if (this.table.format === "lcc")
      return this.unit(node, { kind: "node", node });
    const file = this.table.location[node];
    return this.unit(`file:${file}`, { kind: "file", file });
  }
  unitUrl(unit) {
    const { table } = this;
    if (unit.kind === "file") return table.files[unit.file].url;
    return new URL(
      unit.kind === "environment"
        ? table.companions.environment
        : table.companions.data,
      this.loader.baseUrl,
    ).href;
  }
  pump(now) {
    if (this.disposed || !this.table) return;
    let loading = 0;
    for (const unit of this.units.values()) {
      if (!unit.controller) continue;
      if (this.wanted.has(unit)) loading++;
      else unit.controller.abort();
    }
    for (const [unit, nodes] of this.wanted) {
      if (unit.source) {
        if (unit.source.alive) this.extract(unit, nodes);
        else unit.source = undefined;
      }
      if (unit.source || unit.controller || now < unit.retryAt) continue;
      if (loading >= this.maxConcurrentLoads) continue;
      unit.controller = new AbortController();
      loading++;
      void this.load(unit, unit.controller);
    }
    this.retryTimer.update(this.retryDeadlines());
  }
  *retryDeadlines() {
    for (const unit of this.wanted.keys()) yield unit.retryAt;
  }
  async load(unit, controller) {
    const { signal } = controller;
    try {
      if (unit.kind === "file") {
        const source = await this.loader.loadFile(unit.file, signal);
        if (signal.aborted || this.disposed) source.dispose();
        else {
          unit.source = source;
          if (this.environment?.unit === unit)
            this.environment.count = source.info.numSplats;
        }
      } else if (unit.kind === "environment") {
        const data = await this.loader.loadEnvironment(signal);
        signal.throwIfAborted();
        this.environment.count = data?.numSplats ?? 0;
        if (data?.numSplats) this.arrive(ENVIRONMENT, data);
        // Loaded; the next resolve chooses what else to load.
        this.wanted.delete(unit);
      } else {
        const data = await this.loader.loadNode(unit.node, signal);
        signal.throwIfAborted();
        this.arrive(unit.node, data);
        this.wanted.delete(unit);
      }
      unit.failures = 0;
      unit.retryAt = 0;
    } catch (error) {
      if (!signal.aborted && !this.disposed) {
        unit.retryAt = streamRetryAt(error, unit.failures++);
        // The environment is optional; the scene shows without it.
        if (
          this.environment?.unit === unit &&
          unit.retryAt === Number.POSITIVE_INFINITY
        )
          this.environment.count = 0;
        this.rejectFirstIfUnavailable(error);
        this.failed(error, this.unitUrl(unit));
      }
    } finally {
      unit.controller = undefined;
      if (!this.disposed) {
        // The environment's size changes the budget available to LOD.
        if (this.environment?.unit === unit) void this.requestSelection();
        this.dirty = true;
        this.pump(performance.now());
        this.changed();
      }
    }
  }
  /** Extract wanted nodes from a retained LCC2 file in one worker call. */
  extract(unit, nodes) {
    const pending = nodes.filter((node) => {
      const state = this.state(node);
      return !state.region && !state.data && !state.extracting;
    });
    if (!pending.length) return;
    const { table } = this;
    const ranges = pending.map((node) =>
      node === ENVIRONMENT
        ? { start: 0, count: unit.source.info.numSplats }
        : { start: table.start[node], count: table.count[node] },
    );
    for (const node of pending) this.state(node).extracting = true;
    const source = unit.source;
    void source
      .extract(ranges)
      .then((results) => {
        if (this.disposed) return;
        pending.forEach((node, index) => this.arrive(node, results[index]));
      })
      .catch((error) => {
        if (this.disposed) return;
        unit.retryAt = streamRetryAt(error, unit.failures++);
        if (!source.alive) {
          source.dispose();
          if (unit.source === source) unit.source = undefined;
        }
        this.rejectFirstIfUnavailable(error);
        this.failed(error, this.unitUrl(unit));
      })
      .finally(() => {
        for (const node of pending) {
          const state =
            node === ENVIRONMENT
              ? this.environment?.state
              : this.nodes.get(node);
          if (state) state.extracting = false;
        }
        if (!this.disposed) {
          this.dirty = true;
          this.pump(performance.now());
          this.changed();
        }
      });
  }
  arrive(node, data) {
    // Data on the cut's path can still serve as an intermediate level.
    if (
      node !== ENVIRONMENT &&
      !this.wantedNodes.has(node) &&
      !this.target.has(node) &&
      !this.above.has(node)
    )
      return;
    const state = this.state(node);
    if (state.region) return;
    state.data = data;
    this.arrivals.add(state);
  }
  /** Copy arrived data into batch regions, hidden until the next resolve shows them. */
  writeArrivals() {
    let budget = WRITE_SPLATS_PER_UPDATE;
    for (const state of this.arrivals) {
      if (budget <= 0) break;
      const data = state.data;
      const count = data.numSplats;
      state.writing ??= {
        ...this.pool.allocate(
          count,
          getSplatShDegree(data.extra),
          state.node === ENVIRONMENT ? "lcc-environment" : "lcc-batch",
        ),
        written: 0,
      };
      const { entry, start, written } = state.writing;
      const end = Math.min(count, written + budget);
      entry.batch.writeRegion(start, data, written, end);
      budget -= end - written;
      state.writing.written = end;
      if (end < count) continue;
      this.arrivals.delete(state);
      const { size } = state.writing;
      state.region = {
        entry,
        start,
        size,
        count,
        opacity: 0,
        node: state.node,
      };
      state.writing = undefined;
      state.data = undefined;
      if (state.node !== ENVIRONMENT)
        this.boundsUpdates.push({
          node: state.node,
          centers: Array.from(data.centerOnlyBoundingBox),
          extent: Array.from(data.boundingBox),
        });
      this.dirty = true;
    }
    return false;
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
        region.entry.batch.setRegionOpacity(region.start, opacity);
        if (opacity > 0 && this.shown) this.resolveFirst(this);
        changed = true;
      }
      if (progress === 1) {
        this.fades.delete(region);
        changed = true;
      }
    }
    return changed;
  }
  releaseRegion(state) {
    const region = state.region;
    this.fades.delete(region);
    state.region = undefined;
    this.pool.release(region);
    this.dirty = true;
  }
  /** Hidden regions and LCC2 files stay ready for reuse until their cooldown ends. */
  releaseUnused(now, allowRelease) {
    for (const state of this.allStates()) {
      const { node, region } = state;
      const needed =
        state.shown ||
        this.target.has(node) ||
        this.wantedNodes.has(node) ||
        (node === ENVIRONMENT && this.shown);
      // Arrived data on the cut's path can still serve as an intermediate level.
      if (state.data && !needed && !this.above.has(node)) {
        this.arrivals.delete(state);
        state.data = undefined;
        if (state.writing) this.pool.release(state.writing);
        state.writing = undefined;
      }
      if (region) {
        if (needed || region.opacity > 0 || this.fades.has(region))
          state.expiresAt = undefined;
        else {
          state.expiresAt ??= now + this.cooldownMs;
          if (allowRelease && now >= state.expiresAt) {
            state.expiresAt = undefined;
            this.releaseRegion(state);
          }
        }
      }
      if (
        node !== ENVIRONMENT &&
        !state.region &&
        !state.data &&
        !state.shown &&
        !state.extracting
      )
        this.nodes.delete(node);
    }
    for (const unit of this.units.values()) {
      const source = unit.source;
      if (source && !source.alive) unit.source = undefined;
      if (unit.source) {
        if (this.wanted.has(unit)) unit.expiresAt = undefined;
        else {
          unit.expiresAt ??= now + this.cooldownMs;
          if (allowRelease && now >= unit.expiresAt) {
            unit.source.dispose();
            unit.source = undefined;
            unit.expiresAt = undefined;
          }
        }
      }
      if (
        !unit.source &&
        !unit.controller &&
        !unit.failures &&
        !this.wanted.has(unit) &&
        unit !== this.environment?.unit
      )
        this.units.delete(unit.key);
    }
  }
  changed() {
    if (!this.disposed) notifyStreamChange(this.options);
  }
  failed(error, url) {
    notifyStreamError(this.options, error, url);
  }
  rejectFirstIfUnavailable(error) {
    // A failed refinement does not invalidate already renderable coverage.
    for (const state of this.allStates())
      if (state.region || state.data) return;
    if (
      this.wanted.size > 0 &&
      [...this.wanted.keys()].every(
        (unit) => unit.retryAt === Number.POSITIVE_INFINITY,
      )
    )
      this.rejectFirst(error);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.retryTimer.dispose();
    const reason = new DOMException("LCC scheduler disposed", "AbortError");
    this.abort.abort(reason);
    this.rejectFirst(reason);
    for (const unit of this.units.values()) {
      unit.controller?.abort(reason);
      unit.source?.dispose();
      unit.source = undefined;
    }
    this.loader.dispose();
    this.pool.dispose();
    this.units.clear();
    this.nodes.clear();
    this.shownNodes.clear();
    this.arrivals.clear();
    this.fades.clear();
    this.wanted.clear();
    this.wantedNodes.clear();
    this.environment = undefined;
    this.cut = EMPTY_CUT;
    this.target.clear();
    this.above.clear();
    this.view = undefined;
  }
}
