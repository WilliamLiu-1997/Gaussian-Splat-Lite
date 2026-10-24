import * as THREE from "three";
import { RetryTimer } from "../../../runtime/retry.js";
import { StreamCameras, streamViews } from "../StreamCameras.js";
import {
  notifyStreamChange,
  notifyStreamError,
  positiveInteger,
  streamRetryAt,
} from "../streamOptions.js";
import {
  SceneBatchAllocator,
  sceneBatchMemory,
} from "./SceneBatchAllocator.js";
import { SceneStreamLoader } from "./SceneStreamLoader.js";
import { SceneMemory, sourceMemory } from "./memory.js";
import { SceneSources } from "./resources.js";

function viewScores(units, cameras, group) {
  group.updateWorldMatrix(true, false);
  const views = streamViews(cameras).map((camera) => ({
    frustum: new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4()
        .copy(camera.matrixWorld)
        .invert()
        .premultiply(camera.projectionMatrix)
        .multiply(group.matrixWorld),
      camera.coordinateSystem,
      camera.reversedDepth,
    ),
    position: new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld),
  }));
  const scores = new Map();
  for (const unit of units) {
    const box = new THREE.Box3(
      new THREE.Vector3(...unit.boundingBox.min),
      new THREE.Vector3(...unit.boundingBox.max),
    );
    const world = box.clone().applyMatrix4(group.matrixWorld);
    let distance = Number.POSITIVE_INFINITY;
    for (const view of views)
      if (view.frustum.intersectsBox(box))
        distance = Math.min(distance, world.distanceToPoint(view.position));
    if (Number.isFinite(distance)) scores.set(unit.id, distance);
  }
  return scores;
}

function sourceGroups(ranges) {
  const groups = new Map();
  for (const [index, range] of ranges.entries()) {
    let group = groups.get(range.source.key);
    if (!group) {
      group = {
        source: range.source,
        bytes: sourceMemory(range.source),
        ranges: [],
      };
      groups.set(range.source.key, group);
    }
    group.ranges.push({ range, index });
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Shared lifecycle and residency only; adapters own format parsing and selection policy. */
export class SceneStreamScheduler {
  constructor(options, adapter, dependencies = {}) {
    if (typeof options.url !== "string" || !options.url)
      throw new Error("Scene stream requires url");
    this.options = {
      ...options,
      maxResidentCpuBytes: options.maxResidentCpuBytes ?? 2 * 1024 ** 3,
      maxResidentGpuBytes: options.maxResidentGpuBytes ?? 1024 ** 3,
    };
    this.adapter = adapter;
    this.group = new THREE.Group();
    this.group.name = adapter.name;
    this._splatBudget = positiveInteger(
      options.splatBudget ?? 3_000_000,
      "splatBudget",
    );
    this.memory = new SceneMemory(
      this.options.maxResidentCpuBytes,
      this.options.maxResidentGpuBytes,
    );
    this.abort = new AbortController();
    this.streamCameras = new StreamCameras();
    this.loader =
      dependencies.loader ??
      new SceneStreamLoader(this.options, () => this.changed());
    this.createBatch =
      dependencies.createBatch ??
      (async (count, degree) => {
        const { SogStreamBatch } = await import(
          "../sog-stream/SogStreamBatch.js"
        );
        return new SogStreamBatch(count, degree, this.group, () => {});
      });
    this.batches = new SceneBatchAllocator(this.memory, (count, degree) =>
      this.createBatch(count, degree),
    );
    this.sources = new SceneSources(
      (source, signal) => this.loader.load(source, signal),
      this.memory,
      this.abort.signal,
      () => this.changed(),
    );
    this.shown = new Map();
    this.jobs = new Map();
    this.wanted = new Map();
    this.failures = new Map();
    this.blocked = new Set();
    this.retry = new RetryTimer(() => this.changed());
    this.disposed = false;
    this.dirty = false;
    this.firstSettled = false;
    this.firstRenderable = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.initialized = this.initialize();
    void this.initialized.catch(() => {});
    void this.firstRenderable.catch(() => {});
  }
  get splatBudget() {
    return this._splatBudget;
  }
  set splatBudget(value) {
    const minimum =
      this.model?.coarseCount === undefined
        ? 0
        : this.model.coarseCount + (this.model.environment?.count ?? 0);
    if (value < minimum)
      throw new Error(
        `splatBudget must retain complete coarse coverage; minimum is ${minimum}`,
      );
    this._splatBudget = positiveInteger(value, "splatBudget");
    this.changed();
  }
  get cameras() {
    return this.streamCameras.cameras;
  }
  setCamera(camera) {
    const added = this.streamCameras.add(camera);
    this.changed();
    return added;
  }
  hasCamera(camera) {
    return this.streamCameras.has(camera);
  }
  deleteCamera(camera) {
    const removed = this.streamCameras.delete(camera);
    this.changed();
    return removed;
  }
  getBoundingBox() {
    const bounds = this.model?.boundingBox;
    return bounds
      ? new THREE.Box3(
          new THREE.Vector3(...bounds.min),
          new THREE.Vector3(...bounds.max),
        )
      : new THREE.Box3();
  }
  isVisible() {
    for (let object = this.group; object; object = object.parent)
      if (!object.visible) return false;
    return true;
  }
  get stats() {
    const cameras = this.streamCameras.cameras;
    let visibleSplats = 0;
    let visibleRegions = 0;
    let shDegree = 0;
    const resident = [...this.batches.pages].filter(
      (page) => page.batch,
    ).length;
    const visible = new Set();
    for (const shown of this.shown.values())
      for (const slot of shown.slots) {
        const batch = slot.page.batch;
        shDegree = Math.max(shDegree, slot.degree);
        if (
          !this.isVisible() ||
          batch.visible === false ||
          !cameras.some((camera) =>
            camera.layers.test(batch.layers ?? this.group.layers),
          )
        )
          continue;
        visibleSplats += slot.count;
        visibleRegions++;
        visible.add(batch);
      }
    return {
      ...this.loader.stats,
      visibleSplats,
      visibleRegions,
      shDegree,
      visibleMeshes: visible.size,
      residentMeshes: resident,
      residentChunks: this.sources.entries.size,
      residentBytes: this.memory.cpu + this.memory.gpu,
      pendingBytes: this.batches.pendingBytes + this.sources.pendingBytes,
      cachedBytes: this.sources.cachedBytes,
      failedNodes: this.failures.size,
      loadingChunks: this.jobs.size,
      loadProgress: this.wanted.size
        ? [...this.wanted].filter(
            ([id, rep]) => this.shown.get(id)?.rep.id === rep.id,
          ).length / this.wanted.size
        : 1,
      pendingLoads: this.jobs.size,
      cachedSources: this.sources.entries.size,
      residentCpuBytes: this.memory.cpu,
      residentGpuBytes: this.memory.gpu,
      cpuBudgetEnforced: Number.isFinite(this.memory.maxCpu),
      disposed: this.disposed,
    };
  }
  async initialize() {
    try {
      const model = await this.adapter.read(this.options, this.abort.signal);
      this.abort.signal.throwIfAborted();
      this.metadataRelease = this.memory.reserve(model.metadataBytes * 3);
      if (!this.metadataRelease)
        throw new Error("Scene metadata exceeds maxResidentCpuBytes");
      const envCount = model.environment?.count ?? 0;
      const minima = model.units.map((unit) => unit.representations[0].count);
      const minimum =
        envCount +
        (model.coarseCount ??
          (minima.length
            ? minima.reduce(
                (min, count) => Math.min(min, count),
                Number.POSITIVE_INFINITY,
              )
            : 0));
      if (!minimum) {
        this.model = model;
        this.firstSettled = true;
        this.resolveFirst(this);
        this.changed();
        return this;
      }
      if (this.splatBudget < minimum)
        throw new Error(
          `splatBudget is too small; minimum renderable budget is ${minimum}`,
        );
      const coarse = model.units.map((unit) => unit.representations[0]);
      const alternatives =
        model.coarseCount !== undefined
          ? [coarse]
          : coarse.length
            ? coarse.map((rep) => [rep])
            : [[]];
      const fits = (representations) => {
        const ranges = [
          ...representations.flatMap((rep) => rep.ranges),
          ...(model.environment?.ranges ?? []),
        ];
        const regions = sceneBatchMemory(ranges);
        const sources = [
          ...new Map(
            ranges.map((range) => [range.source.key, range.source]),
          ).values(),
        ];
        return (
          representations.reduce((sum, rep) => sum + rep.count, envCount) <=
            this.splatBudget &&
          this.memory.cpu +
            regions.cpu +
            Math.max(0, ...sources.map((source) => sourceMemory(source))) <=
            this.memory.maxCpu &&
          regions.gpu <= this.memory.maxGpu
        );
      };
      if (!alternatives.some(fits))
        throw new Error(
          "Minimum renderable scene source and region exceed memory budgets",
        );
      this.model = model;
      this.changed();
      return this;
    } catch (error) {
      if (!this.disposed) {
        this.failFirst(error);
        this.dispose();
        notifyStreamError(this.options, error, this.options.url);
      }
      throw error;
    }
  }
  update() {
    if (this.disposed) return false;
    const changed = this.dirty;
    this.dirty = false;
    if (this.model && !this.model.units.length && !this.model.environment)
      return changed;
    const cameras = this.isVisible()
      ? this.streamCameras.seeing(this.group.layers)
      : [];
    for (const shown of this.shown.values())
      for (const batch of shown.batches)
        batch.layers.mask = this.group.layers.mask;
    if (!this.model) return changed;
    const scores = viewScores(this.model.units, cameras, this.group);
    const env = cameras.length ? this.model.environment : undefined;
    const leaves = this.adapter.select(
      this.model.units,
      Math.max(0, this.splatBudget - (env?.count ?? 0)),
      scores,
      this.shown,
    );
    if (
      !this.firstSettled &&
      ((scores.size && !leaves.size && !env) ||
        (env && env.count > this.splatBudget))
    ) {
      this.failReadiness(
        new Error(
          "splatBudget is below the minimum renderable budget for the current view",
        ),
      );
      return true;
    }
    const selected = new Map();
    if (env && env.count <= this.splatBudget) selected.set("environment", env);
    for (const [id, rep] of leaves) selected.set(id, rep);
    this.wanted = selected;
    this.blocked.clear();
    for (const [id, job] of this.jobs)
      if (selected.get(id)?.id !== job.rep.id) this.cancelJob(job);
    for (const [id, shown] of this.shown)
      if (!selected.has(id)) {
        this.releaseShown(shown);
        this.shown.delete(id);
        this.changed();
      }
    this.releaseCoarse();
    if (selected.size && !this.reserveCoarse()) {
      for (const rep of selected.values()) this.blocked.add(rep.id);
      this.checkReadiness();
      return changed || this.dirty;
    }
    // A bounded point budget also includes old regions during atomic replacement.
    let liveCount = [...this.shown.values()].reduce(
      (sum, shown) => sum + shown.rep.count,
      0,
    );
    // A reduced budget cannot retain an oversized old representation indefinitely.
    for (const [id, shown] of this.shown)
      if (
        liveCount > this.splatBudget &&
        shown.rep.id !== selected.get(id)?.id
      ) {
        liveCount -= shown.rep.count;
        this.releaseShown(shown);
        this.shown.delete(id);
        this.changed();
      }
    for (const [id, job] of this.jobs)
      if (!job.cancelled)
        liveCount += job.rep.count - (this.shown.get(id)?.rep.count ?? 0);
    for (const [id, rep] of selected) {
      const old = this.shown.get(id);
      if (old?.rep.id === rep.id || this.jobs.has(id)) continue;
      const failure = this.failures.get(rep.id);
      if (failure && failure.at > performance.now()) continue;
      if (liveCount - (old?.rep.count ?? 0) + rep.count > this.splatBudget) {
        this.blocked.add(rep.id);
        continue;
      }
      if (this.startJob(id, rep))
        liveCount += rep.count - (old?.rep.count ?? 0);
      else this.blocked.add(rep.id);
    }
    this.retry.update([...this.failures.values()].map((failure) => failure.at));
    this.checkReadiness();
    return changed || this.dirty;
  }
  checkReadiness() {
    if (
      this.disposed ||
      this.firstSettled ||
      !this.wanted.size ||
      this.jobs.size ||
      this.sources.closing.size ||
      this.shown.size
    )
      return;
    const exhausted = [...this.wanted.values()].every((rep) => {
      const failure = this.failures.get(rep.id);
      return failure
        ? failure.at === Number.POSITIVE_INFINITY
        : this.blocked.has(rep.id);
    });
    if (exhausted)
      this.failReadiness(
        new Error(
          this.blocked.size
            ? "Selected scene resources failed permanently or cannot fit memory budgets"
            : "All selected scene resources failed permanently",
        ),
      );
  }
  failReadiness(error) {
    this.failFirst(error);
    this.dispose();
    notifyStreamError(this.options, error, this.options.url);
  }
  reserveCoarse() {
    if (this.model.coarseCount === undefined || this.coarseSlots) return true;
    const entries = this.model.units.map((unit) => [
      unit.id,
      unit.representations[0],
    ]);
    if (this.model.environment)
      entries.push(["environment", this.model.environment]);
    const ranges = entries.flatMap(([, rep]) => rep.ranges);
    const allocation = this.batches.estimate(ranges);
    this.sources.trim(allocation.cpu, allocation.gpu);
    const slots = this.batches.reserve(ranges);
    if (!slots) return false;
    // Keep the admitted coarse layout fixed across camera order and detail replacement.
    this.coarseReservations = new Set(slots);
    this.coarseSlots = new Map();
    let offset = 0;
    for (const [id, rep] of entries) {
      this.coarseSlots.set(id, {
        rep,
        slots: slots.slice(offset, offset + rep.ranges.length),
      });
      offset += rep.ranges.length;
    }
    return true;
  }
  releaseSlots(slots) {
    for (const slot of slots) {
      if (this.coarseReservations?.has(slot)) {
        if (slot.published) slot.page.batch.setRegionOpacity(slot.start, 0);
        slot.published = false;
      } else this.batches.release(slot);
    }
  }
  releaseCoarse() {
    if (this.jobs.size || (this.wanted.size && !this.disposed)) return;
    for (const slot of this.coarseReservations ?? [])
      this.batches.release(slot);
    this.coarseSlots = undefined;
    this.coarseReservations = undefined;
  }

  startJob(id, rep) {
    let groups;
    try {
      groups = sourceGroups(rep.ranges);
    } catch (error) {
      this.failed(rep, error);
      return false;
    }
    // Idle caches can expire before a later group is extracted.
    const sourcePeak = Math.max(0, ...groups.map((group) => group.bytes));
    // Keep a decoder envelope for coarse units a later camera can reveal.
    const missing =
      this.shown.has(id) && this.model.coarseCount !== undefined
        ? this.model.units
            .filter(
              (unit) =>
                unit.id !== id &&
                !this.shown.has(unit.id) &&
                !this.jobs.has(unit.id),
            )
            .flatMap((unit) => unit.representations[0].ranges)
        : [];
    const coarse = this.coarseSlots?.get(id);
    const reserved = coarse?.rep.id === rep.id ? coarse.slots : undefined;
    const allocation = reserved
      ? { cpu: 0, gpu: 0 }
      : this.batches.estimate(rep.ranges);
    const peak = Math.max(
      sourcePeak,
      ...[...this.jobs.values()].map((job) => job.peak),
      ...missing.map((range) => sourceMemory(range.source)),
    );
    this.sources.trim(allocation.cpu + peak, allocation.gpu);
    // New pipelines join the current file or wait; prepared cuts must not occupy two decoder envelopes.
    if (
      groups.length &&
      (this.sources.closing.size ||
        [...this.sources.entries.values()].some(
          (entry) => entry.users || entry.pending,
        )) &&
      !this.sources.entries.has(groups[0].source.key)
    )
      return false;
    const stable = this.jobs.size
      ? this.model.metadataBytes * 3 +
        [...this.batches.pages].reduce((sum, page) => sum + page.cpu, 0)
      : this.memory.cpu;
    if (
      stable + allocation.cpu + peak > this.memory.maxCpu ||
      this.memory.gpu + allocation.gpu > this.memory.maxGpu
    )
      return false;
    const slots = reserved ?? this.batches.reserve(rep.ranges);
    if (!slots) return false;
    const releaseMemory = () => this.releaseSlots(slots);
    const leases = new Map();
    try {
      if (groups.length) {
        const first = groups[0].source;
        const lease = this.sources.acquire(first);
        if (!lease) {
          releaseMemory();
          return false;
        }
        leases.set(first.key, lease);
      }
    } catch (error) {
      releaseMemory();
      this.failed(rep, error);
      return false;
    }
    const job = {
      rep,
      groups,
      slots,
      peak: sourcePeak,
      cancelled: false,
      extracting: false,
      controller: new AbortController(),
      leases,
      releaseMemory,
    };
    this.jobs.set(id, job);
    void this.runJob(id, job, leases);
    return true;
  }
  async runJob(id, job, leases) {
    let published = false;
    try {
      for (const [groupIndex, group] of job.groups.entries()) {
        if (this.disposed || job.cancelled) return;
        const lease =
          leases.get(group.source.key) ??
          (await this.sources.acquireWhenAvailable(
            group.source,
            job.controller.signal,
          ));
        leases.set(group.source.key, lease);
        try {
          if (this.disposed || job.cancelled) return;
          const handle = await lease.promise;
          if (this.disposed || job.cancelled) return;
          job.extracting = true;
          for (const { range, index } of group.ranges) {
            if (this.disposed || job.cancelled) return;
            const [data] = await handle.extract([
              { start: range.start, count: range.count },
            ]);
            if (this.disposed || job.cancelled) return;
            await this.batches.write(job.slots[index], data, {
              unit: id,
              node: range.node,
              resource: range.source.url,
              start: range.start + (range.source.sourceOffset ?? 0),
            });
            if (this.disposed || job.cancelled) return;
          }
        } finally {
          job.extracting = false;
          try {
            await lease.release();
            job.peak = Math.max(
              0,
              ...job.groups
                .slice(groupIndex + 1)
                .map((remaining) => remaining.bytes),
            );
          } finally {
            leases.delete(group.source.key);
          }
        }
      }
      if (
        this.disposed ||
        job.cancelled ||
        this.wanted.get(id)?.id !== job.rep.id
      )
        return;
      const old = this.shown.get(id);
      const nextCount =
        [...this.shown.values()].reduce(
          (sum, shown) => sum + shown.rep.count,
          0,
        ) -
        (old?.rep.count ?? 0) +
        job.rep.count;
      if (nextCount > this.splatBudget) return;
      // No await between showing the full replacement and hiding the old representation.
      for (const slot of job.slots)
        this.batches.publish(slot, this.group.layers.mask);
      this.shown.set(id, {
        rep: job.rep,
        slots: job.slots,
        batches: job.slots.map((slot) => slot.page.batch),
      });
      published = true;
      if (old) this.releaseShown(old);
      this.failures.delete(job.rep.id);
      if (!this.firstSettled) {
        this.firstSettled = true;
        this.resolveFirst(this);
      }
      this.changed();
    } catch (error) {
      if (!this.disposed && !job.cancelled) this.failed(job.rep, error);
    } finally {
      await Promise.all(
        [...leases.values()].map((lease) => lease.release()),
      ).catch((error) => {
        if (!this.disposed && !job.cancelled) this.failed(job.rep, error);
      });
      if (!published) job.releaseMemory();
      if (this.jobs.get(id) === job) this.jobs.delete(id);
      this.releaseCoarse();
      this.checkReadiness();
      this.changed();
    }
  }
  cancelJob(job) {
    job.cancelled = true;
    job.controller.abort(
      new DOMException("Scene selection changed", "AbortError"),
    );
    if (!job.extracting)
      for (const lease of job.leases.values()) lease.release();
  }
  releaseShown(shown) {
    this.releaseSlots(shown.slots);
  }
  failed(rep, error) {
    const failures = (this.failures.get(rep.id)?.failures ?? 0) + 1;
    this.failures.set(rep.id, { failures, at: streamRetryAt(error, failures) });
    this.retry.update([...this.failures.values()].map((failure) => failure.at));
    notifyStreamError(
      this.options,
      error,
      rep.ranges[0]?.source.url ?? this.options.url,
    );
    this.changed();
  }
  failFirst(error) {
    if (this.firstSettled) return;
    this.firstSettled = true;
    this.rejectFirst(error);
  }
  changed() {
    if (this.disposed) return;
    this.sources?.wake();
    this.dirty = true;
    notifyStreamChange(this.options);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort(new DOMException("Scene stream disposed", "AbortError"));
    this.retry.dispose();
    for (const job of this.jobs.values()) this.cancelJob(job);
    this.sources.dispose();
    this.loader.dispose();
    for (const shown of this.shown.values()) this.releaseShown(shown);
    this.shown.clear();
    this.releaseCoarse();
    this.metadataRelease?.();
    this.model = undefined;
    this.wanted.clear();
    this.blocked.clear();
    this.failures.clear();
    for (const camera of this.streamCameras.cameras)
      this.streamCameras.delete(camera);
    this.failFirst(this.abort.signal.reason);
  }
}
