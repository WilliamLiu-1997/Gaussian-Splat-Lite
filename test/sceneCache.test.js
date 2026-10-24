import assert from "node:assert/strict";
import test from "node:test";
import { SceneStreamLoader } from "../src/loaders/stream/scene-stream/SceneStreamLoader.js";
import {
  SceneMemory,
  sourceLimits,
  sourceMemory,
} from "../src/loaders/stream/scene-stream/memory.js";
import { SceneSources } from "../src/loaders/stream/scene-stream/resources.js";

const source = {
  key: "one",
  codec: "ply",
  url: "https://scene.invalid/one.ply",
  count: 2,
  shDegree: 0,
};
const other = { ...source, key: "two", url: "https://scene.invalid/two.ply" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const handle = (dispose = () => {}) => ({
  info: { numSplats: 2, numSh: 0, byteLength: 8 },
  dispose,
});

test("sequential node extraction reuses live worker leases and reloads after worker loss", async (context) => {
  let worker;
  let decodes = 0;
  class FakeWorker {
    disposed = false;
    peakWasmMemoryBytes = 65536;
    records = new Map();
    constructor(onDispose) {
      worker = this;
      this.onDispose = onDispose;
    }
    async call(name, args) {
      if (name === "loadSceneSource") {
        decodes++;
        this.records.set(args.id, new Uint32Array([11, 22]));
        return { numSplats: 2, numSh: 0, byteLength: 8 };
      }
      if (name === "extractSceneRanges") {
        const records = this.records.get(args.id);
        assert.ok(records, "the worker must still own the decoded source");
        return args.ranges.map(({ start, count }) =>
          records.slice(start, start + count),
        );
      }
      assert.equal(name, "releaseSceneSource");
      this.records.delete(args.id);
    }
    dispose() {
      this.disposed = true;
      this.records.clear();
      this.onDispose();
    }
  }
  const loader = new SceneStreamLoader({ url: source.url }, () => {});
  loader.workerModule = Promise.resolve({ SceneStreamWorker: FakeWorker });
  const memory = new SceneMemory(sourceMemory(source), 0);
  const cache = new SceneSources(
    (owned, signal) => loader.load(owned, signal),
    memory,
    new AbortController().signal,
  );
  context.after(async () => {
    await cache.dispose();
    loader.dispose();
  });
  const first = cache.acquire(source);
  const decoded = await first.promise;
  assert.deepEqual(await decoded.extract([{ start: 0, count: 1 }]), [
    new Uint32Array([11]),
  ]);
  await first.release();
  assert.equal(worker.disposed, false);
  assert.equal(cache.cachedBytes, 8);
  assert.equal(cache.pendingBytes, 0);
  assert.ok(memory.cpu > cache.cachedBytes, "WASM remains separately charged");
  const second = cache.acquire(source);
  assert.equal(await second.promise, decoded);
  assert.deepEqual(await decoded.extract([{ start: 1, count: 1 }]), [
    new Uint32Array([22]),
  ]);
  assert.equal(decodes, 1);
  await second.release();
  const lostWorker = worker;
  lostWorker.dispose();
  await Promise.resolve();
  const replacement = await cache.acquireWhenAvailable(
    source,
    new AbortController().signal,
  );
  const reloaded = await replacement.promise;
  assert.notEqual(
    reloaded,
    decoded,
    "worker loss must invalidate retained handles",
  );
  assert.notEqual(worker, lostWorker);
  assert.equal(decodes, 2);
  assert.deepEqual(await reloaded.extract([{ start: 1, count: 1 }]), [
    new Uint32Array([22]),
  ]);
  await replacement.release();
  await cache.dispose();
  assert.equal(worker.disposed, true);
  assert.equal(memory.cpu, 0);
  assert.equal(cache.cachedBytes, 0);
});

test("worker loss invalidates pending sources without touching a replacement worker's same-key entry", async (context) => {
  const lost = deferred();
  const replacementLifetime = deferred();
  const decode = deferred();
  const acknowledgement = deferred();
  context.after(() => {
    lost.resolve();
    replacementLifetime.resolve();
    decode.resolve();
    acknowledgement.resolve();
  });
  const oldWorker = {};
  const newWorker = {};
  const pendingSource = { ...source, key: "pending" };
  const memory = new SceneMemory(sourceMemory(source) * 4, 0);
  const loads = [];
  const disposals = [];
  const samples = [];
  const cache = new SceneSources(
    async (owned) => {
      const replacement =
        owned.key === source.key && loads.includes(source.key);
      loads.push(owned.key);
      owned.pinWasm(
        replacement ? newWorker : oldWorker,
        65536,
        replacement ? replacementLifetime.promise : lost.promise,
      );
      if (owned.key === pendingSource.key) await decode.promise;
      return handle(async () => {
        disposals.push(owned.key);
        if (replacement) replacementLifetime.resolve();
        else await acknowledgement.promise;
      });
    },
    memory,
    new AbortController().signal,
    () => samples.push([memory.cpu, cache.cachedBytes, cache.pendingBytes]),
  );
  context.after(() => cache.dispose());
  for (const file of [source, other]) {
    const lease = cache.acquire(file);
    await lease.promise;
    await lease.release();
  }
  const pending = cache.acquire(pendingSource);
  const sharedPending = cache.acquire(pendingSource);
  const rejected = assert.rejects(pending.promise, { name: "AbortError" });
  void rejected.catch(() => {});
  await tick();
  // Evict just the first idle source; its close remains unacknowledged during replacement.
  cache.trim(memory.maxCpu - memory.cpu + 8);
  await tick();
  assert.deepEqual(disposals, [source.key]);
  const replacement = cache.acquire(source);
  const freshHandle = await replacement.promise;
  lost.resolve();
  await Promise.resolve();
  assert.equal(cache.entries.has(other.key), false);
  assert.equal(cache.entries.has(pendingSource.key), false);
  await tick();
  assert.deepEqual(disposals, [source.key, other.key]);
  assert.equal(
    cache.cachedBytes,
    24,
    "old arrays stay charged until close acknowledgement",
  );
  const pendingBytes =
    sourceMemory(pendingSource) - sourceLimits(pendingSource).maxWasmBytes;
  assert.equal(cache.pendingBytes, pendingBytes);
  assert.equal(
    memory.cpu,
    sourceLimits(source).maxWasmBytes + 24 + pendingBytes,
  );
  const joined = cache.acquire(source);
  assert.equal(await joined.promise, freshHandle);
  assert.deepEqual(loads, [
    source.key,
    other.key,
    pendingSource.key,
    source.key,
  ]);
  const release = pending.release();
  assert.equal(sharedPending.release(), release);
  let released = false;
  void release.then(() => {
    released = true;
  });
  decode.resolve();
  await tick();
  assert.equal(released, false);
  assert.equal(cache.pendingBytes, pendingBytes);
  assert.deepEqual(disposals, [source.key, other.key, pendingSource.key]);
  const closing = Promise.all(cache.closing);
  acknowledgement.resolve();
  await Promise.all([rejected, release, closing]);
  assert.equal(cache.pendingBytes, 0);
  assert.equal(cache.cachedBytes, 8);
  assert.equal(memory.cpu, sourceLimits(source).maxWasmBytes + 8);
  // A load can reach pinWasm after the worker's lifetime callback already ran.
  const late = cache.acquire({ ...source, key: "late" });
  await assert.rejects(late.promise, { name: "AbortError" });
  await late.release();
  assert.equal(cache.cachedBytes, 8);
  assert.equal(memory.cpu, sourceLimits(source).maxWasmBytes + 8);
  const joinedRelease = joined.release();
  await replacement.release();
  await joinedRelease;
  await cache.dispose();
  assert.deepEqual(disposals, [
    source.key,
    other.key,
    pendingSource.key,
    "late",
    source.key,
  ]);
  assert.equal(memory.cpu, 0);
  assert.equal(cache.cachedBytes, 0);
  assert.equal(cache.pendingBytes, 0);
  assert.ok(samples.every((values) => values.every((value) => value >= 0)));
});

test(
  "pressure evicts idle sources but does not reclaim memory before cache acknowledgement",
  { timeout: 1000 },
  async (context) => {
    const acknowledgement = deferred();
    context.after(() => acknowledgement.resolve());
    const memory = new SceneMemory(sourceMemory(source) + 32, 32);
    const baseline = memory.reserve(32, 16);
    const loads = [];
    let changes = 0;
    const cache = new SceneSources(
      async (owned) => {
        loads.push(owned.key);
        return handle(
          () => owned.key === source.key && acknowledgement.promise,
        );
      },
      memory,
      new AbortController().signal,
      () => changes++,
    );
    context.after(() => cache.dispose());
    const first = cache.acquire(source);
    await first.promise;
    const released = first.release();
    assert.equal(first.release(), released);
    await released;
    assert.equal(cache.cachedBytes, 8);
    const held = memory.cpu;
    cache.trim(sourceMemory(other), 8);
    const next = cache.acquireWhenAvailable(
      other,
      new AbortController().signal,
    );
    await tick();
    assert.deepEqual(loads, ["one"]);
    assert.equal(memory.cpu, held);
    assert.equal(
      cache.cachedBytes,
      8,
      "closing arrays remain owned until acknowledged",
    );
    assert.equal(cache.pendingBytes, 0);
    const beforeAck = changes;
    acknowledgement.resolve();
    const lease = await next;
    await lease.promise;
    assert.deepEqual(loads, ["one", "two"]);
    assert.ok(changes > beforeAck, "acknowledgement wakes reservation retries");
    await lease.release();
    const reused = await cache.acquireWhenAvailable(
      source,
      new AbortController().signal,
    );
    await reused.promise;
    assert.deepEqual(loads, ["one", "two", "one"]);
    assert.ok(memory.cpu <= memory.maxCpu);
    await reused.release();
    await cache.dispose();
    assert.equal(memory.cpu, 32);
    assert.equal(memory.gpu, 16);
    assert.equal(cache.cachedBytes, 0);
    assert.equal(cache.pendingBytes, 0);
    baseline();
  },
);

test(
  "whole-file waiters advance on last release without waiting for idle cooldown",
  { timeout: 1000 },
  async (context) => {
    const loads = [];
    const memory = new SceneMemory(sourceMemory(source) * 2, 0);
    const cache = new SceneSources(
      async (owned) => {
        loads.push(owned.key);
        return handle();
      },
      memory,
      new AbortController().signal,
    );
    context.after(() => cache.dispose());
    const first = cache.acquire(source);
    await first.promise;
    const next = cache.acquireWhenAvailable(
      other,
      new AbortController().signal,
    );
    await tick();
    assert.deepEqual(
      loads,
      ["one"],
      "a different active source still serializes admission",
    );
    await first.release();
    const second = await next;
    await second.promise;
    assert.deepEqual(loads, ["one", "two"]);
    assert.equal(
      cache.cachedBytes,
      16,
      "idle arrays may coexist with the next source when budget permits",
    );
    await second.release();
  },
);

test("idle cooldown resets on reuse and expires without camera updates", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let disposals = 0;
  const memory = new SceneMemory(sourceMemory(source), 0);
  const cache = new SceneSources(
    async () => handle(() => disposals++),
    memory,
    new AbortController().signal,
  );
  context.after(() => cache.dispose());
  const first = cache.acquire(source);
  await first.promise;
  await first.release();
  context.mock.timers.tick(1999);
  await tick();
  assert.equal(disposals, 0);
  const second = cache.acquire(source);
  await second.promise;
  await second.release();
  context.mock.timers.tick(1);
  await tick();
  assert.equal(disposals, 0, "the old expiry cannot evict a reused source");
  context.mock.timers.tick(1999);
  await tick();
  assert.equal(disposals, 1);
  assert.equal(cache.cachedBytes, 0);
  assert.equal(memory.cpu, 0);
});

test(
  "scene abort closes idle data while canceled decode release waits for completion and acknowledgement",
  { timeout: 1000 },
  async (context) => {
    const decode = deferred();
    const acknowledgement = deferred();
    context.after(() => {
      decode.resolve();
      acknowledgement.resolve();
    });
    const abort = new AbortController();
    const memory = new SceneMemory(sourceMemory(source) * 2, 0);
    let disposed = 0;
    const cache = new SceneSources(
      async (owned) => {
        if (owned.key === other.key) await decode.promise;
        return handle(async () => {
          disposed++;
          if (owned.key === other.key) await acknowledgement.promise;
        });
      },
      memory,
      abort.signal,
    );
    context.after(() => cache.dispose());
    const idle = cache.acquire(source);
    await idle.promise;
    await idle.release();
    const pending = cache.acquire(other);
    const rejected = assert.rejects(pending.promise, { name: "AbortError" });
    await tick();
    assert.equal(cache.cachedBytes, 8);
    assert.equal(cache.pendingBytes, sourceMemory(other));
    abort.abort();
    const release = pending.release();
    let released = false;
    void release.then(() => {
      released = true;
    });
    const completed = cache.dispose();
    await tick();
    assert.equal(disposed, 1);
    assert.equal(cache.cachedBytes, 0);
    assert.equal(cache.pendingBytes, sourceMemory(other));
    assert.equal(memory.cpu, sourceMemory(other));
    assert.equal(released, false);
    decode.resolve();
    await tick();
    assert.equal(disposed, 2);
    assert.equal(released, false);
    assert.equal(memory.cpu, sourceMemory(other));
    acknowledgement.resolve();
    await Promise.all([rejected, release, completed]);
    assert.equal(released, true);
    assert.equal(cache.cachedBytes, 0);
    assert.equal(cache.pendingBytes, 0);
    assert.equal(memory.cpu, 0);
  },
);
