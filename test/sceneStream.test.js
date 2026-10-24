import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { SogRegionSplats } from "../src/data/SogRegionSplats.js";
import { LccStreamScheduler } from "../src/loaders/stream/lcc-stream/LccStreamScheduler.js";
import { selectLccUnits } from "../src/loaders/stream/lcc-stream/lccScene.js";
import { Lcc2StreamScheduler } from "../src/loaders/stream/lcc2-stream/Lcc2StreamScheduler.js";
import { sceneBatchMemory } from "../src/loaders/stream/scene-stream/SceneBatchAllocator.js";
import { SceneStreamLoader } from "../src/loaders/stream/scene-stream/SceneStreamLoader.js";
import { SceneStreamScheduler } from "../src/loaders/stream/scene-stream/SceneStreamScheduler.js";
import {
  SceneMemory,
  regionMemory,
  sourceMemory,
} from "../src/loaders/stream/scene-stream/memory.js";
import {
  SceneSources,
  readSceneBytes,
} from "../src/loaders/stream/scene-stream/resources.js";

const bounds = { min: [-1, -1, -3], max: [1, 1, -1] };
const source = {
  key: "shared",
  codec: "lcc",
  url: "https://scene.invalid/data.bin",
  count: 8,
  shDegree: 0,
  inputBytes: 256,
  sourceOffset: 0,
};
const rep = (id, count, start = 0) => ({
  id,
  count,
  ranges: [{ source, start, count }],
});
const unit = {
  id: "u",
  boundingBox: bounds,
  representations: [rep("coarse", 2), rep("fine", 8)],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function schedulerHarness({ extract, read, budget = 8, gpu, cpu } = {}) {
  const batches = [];
  let loads = 0;
  const scheduler = new SceneStreamScheduler(
    {
      url: "https://scene.invalid/scene.lcc",
      splatBudget: budget,
      maxResidentGpuBytes: gpu,
      maxResidentCpuBytes: cpu,
      onError() {},
    },
    {
      name: "test-scene",
      read:
        read ??
        (async () => ({
          units: [unit],
          boundingBox: bounds,
          metadataBytes: 10,
        })),
      select: selectLccUnits,
    },
    {
      loader: {
        stats: {},
        dispose() {},
        async load() {
          loads++;
          return {
            dispose() {},
            extract:
              extract ??
              (async (ranges) =>
                ranges.map((range) => ({ numSplats: range.count, extra: {} }))),
          };
        },
      },
      createBatch: async () => {
        const batch = {
          userData: {},
          layers: new THREE.Layers(),
          visible: false,
          disposed: false,
          opacities: new Map(),
          writeRegion() {},
          setRegionOpacity(start, opacity) {
            this.opacities.set(start, opacity);
            this.visible = [...this.opacities.values()].some(
              (value) => value > 0,
            );
          },
          removeFromParent() {
            this.visible = false;
          },
          dispose() {
            this.disposed = true;
          },
        };
        batches.push(batch);
        return batch;
      },
    },
  );
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  scheduler.setCamera(camera);
  return { scheduler, batches, loads: () => loads };
}

test("scene culling uses the actual XR eye rig scale instead of a sanitized inverse", async () => {
  const { scheduler, loads } = schedulerHarness({ budget: 2 });
  scheduler.deleteCamera(scheduler.cameras[0]);
  const eye = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  eye.viewport = new THREE.Vector4(0, 0, 640, 480);
  eye.matrixWorld.makeScale(100, 100, 100);
  eye.matrixWorldInverse.identity();
  scheduler.setCamera(new THREE.ArrayCamera([eye]));
  await scheduler.initialized;
  scheduler.update();
  await flush();
  assert.equal(loads(), 0);
  eye.matrixWorld.identity();
  scheduler.update();
  await scheduler.firstRenderable;
  assert.equal(scheduler.stats.visibleSplats, 2);
  scheduler.dispose();
  await flush();
});

test("budget changes cannot discard required coarse coverage", async () => {
  const { scheduler } = schedulerHarness({
    read: async () => ({
      units: [unit],
      coarseCount: 2,
      boundingBox: bounds,
      metadataBytes: 10,
    }),
  });
  await scheduler.initialized;
  assert.throws(() => {
    scheduler.splatBudget = 1;
  }, /complete coarse coverage/);
  assert.equal(scheduler.splatBudget, 8);
  scheduler.dispose();
});

test("scene defaults cap owned CPU/GPU buffers and require complete coarse coverage", async () => {
  const { scheduler } = schedulerHarness({
    budget: 3,
    read: async () => ({
      units: [unit, { ...unit, id: "v" }],
      coarseCount: 4,
      boundingBox: bounds,
      metadataBytes: 10,
    }),
  });
  assert.equal(scheduler.options.maxResidentCpuBytes, 2 * 1024 ** 3);
  assert.equal(scheduler.options.maxResidentGpuBytes, 1024 ** 3);
  await assert.rejects(scheduler.initialized, /minimum renderable budget is 4/);
  await assert.rejects(
    scheduler.firstRenderable,
    /minimum renderable budget is 4/,
  );
  assert.equal(scheduler.stats.disposed, true);
});

test("minimum admission must fit point and memory budgets together", async () => {
  for (const options of [
    { budget: 1 },
    { gpu: 1 },
    {
      budget: 1,
      gpu: regionMemory(2, 0).gpu,
      read: async () => ({
        units: [
          {
            ...unit,
            representations: [
              {
                id: "point-only",
                count: 1,
                ranges: [
                  { source: { ...source, shDegree: 3 }, start: 0, count: 1 },
                ],
              },
            ],
          },
          { ...unit, id: "memory-only" },
        ],
        boundingBox: bounds,
        metadataBytes: 10,
      }),
    },
  ]) {
    const { scheduler, loads } = schedulerHarness(options);
    await assert.rejects(scheduler.initialized, /minimum|Minimum/);
    await assert.rejects(scheduler.firstRenderable, /minimum|Minimum/);
    assert.equal(loads(), 0);
    assert.equal(scheduler.stats.disposed, true);
  }
});

test("complete coarse coverage must fit CPU and GPU budgets before loading", async () => {
  const region = sceneBatchMemory(
    [rep("a", 2), rep("b", 2), rep("env", 2)].flatMap((item) => item.ranges),
  );
  const cpu = 30 + region.cpu + sourceMemory(source);
  const gpu = region.gpu;
  for (const limits of [
    { cpu: cpu - 1, gpu },
    { cpu, gpu: gpu - 1 },
    { cpu, gpu },
  ]) {
    const { scheduler, loads } = schedulerHarness({
      ...limits,
      read: async () => ({
        units: [unit, { ...unit, id: "second" }],
        environment: rep("environment", 2, 4),
        coarseCount: 4,
        boundingBox: bounds,
        metadataBytes: 10,
      }),
    });
    try {
      if (limits.cpu < cpu || limits.gpu < gpu) {
        await assert.rejects(scheduler.initialized, /memory budgets/);
        await assert.rejects(scheduler.firstRenderable, /memory budgets/);
        assert.equal(loads(), 0);
        assert.equal(scheduler.stats.residentBytes, 0);
      } else {
        await scheduler.initialized;
        scheduler.update();
        await scheduler.firstRenderable;
        await flush();
        assert.equal(scheduler.stats.visibleSplats, 6);
      }
    } finally {
      scheduler.dispose();
      await flush();
    }
  }
});

test("memory envelopes cover actual packed storage and enforce independent CPU/GPU limits", () => {
  const storage = new SogRegionSplats(2, 3);
  try {
    storage.prepareIndices(2);
    const region = regionMemory(2, 3);
    assert.ok(region.gpu >= storage.textureByteLength);
    assert.ok(region.cpu >= storage.getByteLength());
  } finally {
    storage.dispose();
  }
  const memory = new SceneMemory(100, 20);
  const release = memory.reserve(90, 20);
  assert.ok(release);
  assert.equal(memory.reserve(11, 0), undefined);
  assert.equal(memory.reserve(0, 1), undefined);
  release();
  release();
  assert.equal(memory.cpu, 0);
  assert.equal(memory.gpu, 0);
  assert.throws(() => memory.reserve(Number.POSITIVE_INFINITY), /cannot bound/);
});

test("shared sources deduplicate loads and preserve active owners until cache disposal", async () => {
  const task = deferred();
  const abort = new AbortController();
  let loads = 0;
  let signal;
  let disposed = 0;
  const memory = new SceneMemory(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const cache = new SceneSources(
    async (_source, request) => {
      loads++;
      signal = request;
      return task.promise;
    },
    memory,
    abort.signal,
  );
  const first = cache.acquire(source);
  const second = cache.acquire(source);
  await flush();
  assert.equal(loads, 1);
  first.release();
  assert.equal(signal.aborted, false);
  task.resolve({
    dispose() {
      disposed++;
    },
  });
  await second.promise;
  second.release();
  await cache.dispose();
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(disposed, 1);
  assert.equal(memory.cpu, 0);
});

test("a cancelled shared load cannot publish a late cache handle", async () => {
  const task = deferred();
  const cache = new SceneSources(
    () => task.promise,
    new SceneMemory(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    new AbortController().signal,
  );
  const lease = cache.acquire(source);
  await flush();
  lease.release();
  let disposed = 0;
  task.resolve({
    dispose() {
      disposed++;
    },
  });
  await assert.rejects(lease.promise, { name: "AbortError" });
  assert.equal(disposed, 1);
  assert.equal(cache.entries.size, 0);
});

test("disposing during extraction prevents late batch publication", async () => {
  const task = deferred();
  const { scheduler, batches } = schedulerHarness({
    extract: () => task.promise,
  });
  await scheduler.initialized;
  scheduler.update();
  await flush();
  scheduler.dispose();
  task.resolve([{ numSplats: 2, extra: {} }]);
  await flush();
  await assert.rejects(scheduler.firstRenderable, { name: "AbortError" });
  assert.equal(batches.length, 0);
  assert.equal(scheduler.stats.visibleSplats, 0);
  assert.equal(scheduler.stats.residentGpuBytes, 0);
});

test("a permanent first-load failure rejects firstRenderable without another update", async () => {
  const { scheduler } = schedulerHarness({
    extract: async () => {
      throw new Error("Invalid source range");
    },
  });
  await scheduler.initialized;
  scheduler.update();
  await assert.rejects(scheduler.firstRenderable, /failed permanently/);
  scheduler.dispose();
});

test("dispose before manifest completion rejects both readiness promises", async () => {
  const task = deferred();
  const { scheduler } = schedulerHarness({ read: () => task.promise });
  scheduler.dispose();
  task.resolve({ units: [unit], boundingBox: bounds, metadataBytes: 10 });
  await assert.rejects(scheduler.initialized, { name: "AbortError" });
  await assert.rejects(scheduler.firstRenderable, { name: "AbortError" });
  assert.equal(scheduler.group.children.length, 0);
});

test("successful replacement shares free slots but requires overlap GPU admission for another page", async () => {
  const coarse = rep("large-coarse", 8192);
  const fine = rep("large-fine", 16384);
  const { scheduler } = schedulerHarness({
    budget: 16384,
    gpu: regionMemory(16384, 0).gpu,
    read: async () => ({
      units: [{ ...unit, representations: [coarse, fine] }],
      boundingBox: bounds,
      metadataBytes: 10,
    }),
  });
  await scheduler.initialized;
  scheduler.update();
  await flush();
  const old = scheduler.shown.get("u").slots[0];
  scheduler.update();
  await flush();
  assert.equal(scheduler.stats.visibleSplats, 8192);
  assert.equal(
    old.published,
    true,
    "old coverage survives an inadmissible replacement",
  );
  scheduler.dispose();
  const unrestricted = schedulerHarness();
  await unrestricted.scheduler.initialized;
  unrestricted.scheduler.update();
  await flush();
  const previous = unrestricted.scheduler.shown.get("u").slots[0];
  unrestricted.scheduler.update();
  await flush();
  assert.equal(unrestricted.scheduler.stats.visibleSplats, 8);
  assert.equal(previous.released, true);
  assert.equal(
    unrestricted.batches.length,
    1,
    "small atomic replacements reuse shared backing storage",
  );
  assert.equal(unrestricted.batches[0].visible, true);
  unrestricted.scheduler.dispose();
});

test("optional environment fetch accepts only a bounded 404 absence", async (context) => {
  let status = 404;
  let fetches = 0;
  context.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return new Response("missing", { status });
  });
  const options = { url: "https://scene.invalid/a.lcc" };
  assert.equal(
    await readSceneBytes(
      "https://scene.invalid/environment.bin",
      options,
      new AbortController().signal,
      100,
      true,
    ),
    undefined,
  );
  status = 403;
  await assert.rejects(
    readSceneBytes(
      "https://scene.invalid/environment.bin",
      options,
      new AbortController().signal,
      100,
      true,
    ),
    /HTTP 403/,
  );
  status = 200;
  await assert.rejects(
    readSceneBytes(
      "https://scene.invalid/environment.bin",
      options,
      new AbortController().signal,
      1,
      true,
    ),
    /byte limit/,
  );
  const failure = new Error("Ambiguous companion filename");
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => {
    throw failure;
  });
  await assert.rejects(
    readSceneBytes(
      "https://scene.invalid/environment.bin",
      { ...options, manager },
      new AbortController().signal,
      100,
      true,
    ),
    (error) => error === failure,
  );
  assert.equal(fetches, 3, "resolver failure must not reach fetch");
});

test("worker bridge resolves nested SOG assets by logical source URL through blob managers", async (context) => {
  const resolved = [];
  const calls = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    resolved.push(url);
    return `blob:https://local.invalid/${resolved.length}`;
  });
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(String(url).startsWith("blob:"));
    return new Response(new Uint8Array([1, 2, 3]));
  });
  class FakeWorker {
    disposed = false;
    peakWasmMemoryBytes = 0;
    async call(name, args, options) {
      calls.push({ name, args });
      if (name === "loadSceneSource") {
        await options.onStatus({ loaded: 10 });
        await options.onStatus({
          fileRequest: 1,
          filename: "images/means.webp",
        });
        return { numSplats: 2, numSh: 0, byteLength: 64 };
      }
    }
    dispose() {
      this.disposed = true;
    }
  }
  const loader = new SceneStreamLoader(
    { url: "https://local.invalid/model/scene.lcc2", manager },
    () => {},
  );
  // Internal import seam avoids starting a real browser Worker in Node.
  loader.workerModule = Promise.resolve({ SceneStreamWorker: FakeWorker });
  const handle = await loader.load(
    {
      ...source,
      codec: "sog",
      url: "https://local.invalid/model/nested/chunk.sog",
    },
    new AbortController().signal,
  );
  assert.deepEqual(resolved, [
    "https://local.invalid/model/nested/chunk.sog",
    "https://local.invalid/model/nested/images/means.webp",
  ]);
  assert.equal(
    calls.find((call) => call.name === "loadSceneSource").args.url,
    "blob:https://local.invalid/1",
  );
  assert.equal(
    calls.find((call) => call.name === "loadSceneSource").args.source.url,
    "https://local.invalid/model/nested/chunk.sog",
  );
  assert.deepEqual(
    calls.find((call) => call.name === "resolveFile").args.input,
    new Uint8Array([1, 2, 3]),
  );
  handle.dispose();
  loader.dispose();
});

test("environment admission comes before leaves under GPU pressure", async () => {
  const environment = rep("environment", 8192);
  const coarse = { ...unit, representations: [rep("coarse", 8192)] };
  const { scheduler } = schedulerHarness({
    budget: 24576,
    gpu: regionMemory(8192, 0).gpu * 2,
    read: async () => ({
      units: [coarse, { ...coarse, id: "v" }],
      environment,
      boundingBox: bounds,
      metadataBytes: 10,
    }),
  });
  await scheduler.initialized;
  scheduler.update();
  await flush();
  assert.ok(
    scheduler.shown.get("environment").slots.every((slot) => slot.published),
  );
  assert.equal(scheduler.stats.visibleSplats, 16384);
  scheduler.dispose();
});

test("empty normalized scene resolves both promises without cameras or workers", async () => {
  const { scheduler, loads } = schedulerHarness({
    gpu: 0,
    read: async () => ({ units: [], boundingBox: bounds, metadataBytes: 10 }),
  });
  for (const camera of scheduler.cameras) scheduler.deleteCamera(camera);
  assert.equal(await scheduler.initialized, scheduler);
  assert.equal(await scheduler.firstRenderable, scheduler);
  scheduler.update();
  assert.equal(scheduler.update(), false);
  assert.equal(loads(), 0);
  assert.equal(scheduler.stats.pendingLoads, 0);
  scheduler.dispose();
  assert.equal(scheduler.stats.residentCpuBytes, 0);
});

test("native empty LCC and LCC2 accept finite CPU metadata budgets and zero GPU budgets", async (context) => {
  const lcc = {
    version: "5.0",
    encoding: "COMPRESS",
    fileType: "Portable",
    totalLevel: 1,
    totalSplats: 0,
    indexDataSize: 20,
    splats: [0],
    cellLengthX: 1,
    cellLengthY: 1,
    boundingBox: bounds,
    attributes: [{ name: "scale", min: [0, 0, 0], max: [1, 1, 1] }],
  };
  const lcc2 = {
    version: "0.0.3",
    splatType: ".spz",
    totalLevels: 1,
    totalSplats: 0,
    lodSplats: [0],
    env: { type: "splats", splatsCount: 0, boundingBox: bounds },
    root: {
      id: "empty",
      boundingBox: bounds,
      childNum: 0,
      splatFiles: ["empty.spz", "sky.spz"],
      data: { "3dgs": { name: 0, start: 0, count: 0 }, env: { name: 1 } },
    },
  };
  for (const [Class, metadata, extension] of [
    [LccStreamScheduler, lcc, "lcc"],
    [Lcc2StreamScheduler, lcc2, "lcc2"],
  ]) {
    const fetched = [];
    const manager = new THREE.LoadingManager();
    manager.getFileSize = (url) =>
      String(url).endsWith("/index.bin") ? 0 : null;
    context.mock.method(globalThis, "fetch", async (url) => {
      fetched.push(url);
      return new Response(
        String(url).endsWith("index.bin")
          ? new Uint8Array(0)
          : JSON.stringify(metadata),
      );
    });
    const scheduler = new Class({
      url: `https://scene.invalid/empty.${extension}`,
      manager,
      maxResidentCpuBytes: 65536,
      maxResidentGpuBytes: 0,
    });
    assert.equal(await scheduler.initialized, scheduler);
    assert.equal(await scheduler.firstRenderable, scheduler);
    scheduler.update();
    assert.equal(scheduler.stats.visibleSplats, 0);
    assert.equal(scheduler.stats.pendingLoads, 0);
    assert.equal(scheduler.stats.residentGpuBytes, 0);
    assert.equal(fetched.length, extension === "lcc" ? 2 : 1);
    scheduler.dispose();
    assert.equal(scheduler.stats.residentCpuBytes, 0);
    context.mock.restoreAll();
  }
});

test("manifest failure closes its loader once without acquiring sources", async () => {
  const task = deferred();
  const { scheduler, loads } = schedulerHarness({ read: () => task.promise });
  let loaderDisposed = 0;
  scheduler.loader.dispose = () => {
    loaderDisposed++;
  };
  task.reject(new Error("Invalid manifest"));
  await assert.rejects(scheduler.initialized, /Invalid manifest/);
  await assert.rejects(scheduler.firstRenderable, /Invalid manifest/);
  scheduler.dispose();
  await flush();
  assert.equal(loads(), 0);
  assert.equal(loaderDisposed, 1);
  assert.equal(scheduler.sources.entries.size, 0);
  assert.equal(scheduler.stats.residentCpuBytes, 0);
  assert.equal(scheduler.cameras.length, 0);
});

test(
  "permanent failure plus an inadmissible region cannot leave readiness pending",
  { timeout: 1000 },
  async () => {
    const largeSource = {
      ...source,
      key: "large",
      count: 9000,
      inputBytes: 9000 * 32,
    };
    const large = {
      id: "large",
      count: 9000,
      ranges: [{ source: largeSource, start: 0, count: 9000 }],
    };
    const { scheduler } = schedulerHarness({
      budget: 9002,
      gpu: regionMemory(2, 0).gpu,
      read: async () => ({
        units: [unit, { ...unit, id: "large", representations: [large] }],
        boundingBox: bounds,
        metadataBytes: 10,
      }),
      extract: async () => {
        throw new Error("Invalid payload");
      },
    });
    await scheduler.initialized;
    scheduler.update();
    await assert.rejects(
      scheduler.firstRenderable,
      /failed permanently|memory budgets/,
    );
    await flush();
    assert.equal(scheduler.stats.disposed, true);
    assert.equal(scheduler.stats.residentGpuBytes, 0);
    assert.equal(scheduler.stats.residentCpuBytes, 0);
  },
);

test("visible counters honor hidden ancestors and camera layers; batches follow group layers", async () => {
  const { scheduler, batches } = schedulerHarness({ budget: 2 });
  await scheduler.initialized;
  scheduler.update();
  await flush();
  assert.equal(scheduler.stats.visibleSplats, 2);
  const resident = scheduler.stats.residentGpuBytes;
  scheduler.group.visible = false;
  assert.equal(scheduler.stats.visibleSplats, 0);
  assert.equal(scheduler.stats.visibleMeshes, 0);
  assert.equal(scheduler.stats.residentGpuBytes, resident);
  scheduler.group.visible = true;
  const parent = new THREE.Group();
  parent.add(scheduler.group);
  parent.visible = false;
  assert.equal(scheduler.stats.visibleSplats, 0);
  parent.visible = true;
  scheduler.group.layers.set(3);
  scheduler.cameras[0].layers.set(3);
  scheduler.update();
  await flush();
  assert.equal(batches[0].layers.mask, scheduler.group.layers.mask);
  assert.equal(scheduler.stats.visibleSplats, 2);
  scheduler.cameras[0].layers.set(4);
  assert.equal(scheduler.stats.visibleSplats, 0);
  scheduler.dispose();
});

test("shrinking splatBudget releases oversized old detail even when overlap cannot fit", async () => {
  const { scheduler } = schedulerHarness();
  await scheduler.initialized;
  scheduler.update();
  await flush();
  scheduler.update();
  await flush();
  assert.equal(scheduler.stats.visibleSplats, 8);
  const fine = scheduler.shown.get("u").slots[0];
  scheduler.memory.maxGpu = regionMemory(2, 0).gpu;
  scheduler.splatBudget = 2;
  scheduler.update();
  assert.ok(scheduler.stats.visibleSplats <= 2);
  await flush();
  assert.equal(scheduler.stats.visibleSplats, 2);
  assert.equal(fine.released, true);
  assert.equal(scheduler.shown.get("u").slots[0].page.batch.visible, true);
  scheduler.dispose();
});

test("failed batch publication releases packed storage, cached source, and loader", async () => {
  const { scheduler, batches } = schedulerHarness();
  let handlesDisposed = 0;
  let loaderDisposed = 0;
  scheduler.loader.load = async () => ({
    dispose() {
      handlesDisposed++;
    },
    extract: async (ranges) =>
      ranges.map((range) => ({ numSplats: range.count, extra: {} })),
  });
  scheduler.loader.dispose = () => {
    loaderDisposed++;
  };
  const create = scheduler.createBatch;
  scheduler.createBatch = async (...args) => {
    const batch = await create(...args);
    batch.writeRegion = () => {
      throw new Error("Invalid packed region");
    };
    return batch;
  };
  await scheduler.initialized;
  scheduler.update();
  await assert.rejects(scheduler.firstRenderable, /failed permanently/);
  await flush();
  assert.equal(batches[0].disposed, true);
  assert.equal(handlesDisposed, 1);
  assert.equal(loaderDisposed, 1);
  assert.equal(scheduler.stats.residentGpuBytes, 0);
  assert.equal(scheduler.stats.residentCpuBytes, 0);
});

test("source cache disposal rejects new owners and disposes late handles once", async () => {
  const task = deferred();
  const memory = new SceneMemory(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const cache = new SceneSources(
    () => task.promise,
    memory,
    new AbortController().signal,
  );
  const first = cache.acquire(source);
  const second = cache.acquire(source);
  await flush();
  cache.dispose();
  cache.dispose();
  assert.throws(() => cache.acquire(source), { name: "AbortError" });
  assert.ok(
    memory.cpu > 0,
    "pending decode retains its reservation until it settles",
  );
  let disposed = 0;
  task.resolve({
    dispose() {
      disposed++;
    },
  });
  await assert.rejects(first.promise, { name: "AbortError" });
  first.release();
  second.release();
  await flush();
  assert.equal(disposed, 1);
  assert.equal(memory.cpu, 0);
});

test(
  "loader disposal cancels a pending worker import without spawning a late worker",
  { timeout: 1000 },
  async () => {
    const module = deferred();
    const loader = new SceneStreamLoader(
      { url: "https://scene.invalid/scene.lcc" },
      () => {},
    );
    loader.workerModule = module.promise;
    const pending = loader.load(source, new AbortController().signal);
    loader.dispose();
    await assert.rejects(pending, { name: "AbortError" });
    let workers = 0;
    module.resolve({
      SceneStreamWorker: class {
        constructor() {
          workers++;
        }
      },
    });
    await flush();
    assert.equal(workers, 0);
  },
);

test("a view whose smallest visible representation exceeds splatBudget fails readiness", async () => {
  const visible = { ...unit, representations: [rep("large", 8)] };
  const offscreen = {
    ...unit,
    id: "offscreen",
    boundingBox: { min: [99, -1, -3], max: [101, 1, -1] },
  };
  const { scheduler, loads } = schedulerHarness({
    budget: 2,
    read: async () => ({
      units: [visible, offscreen],
      boundingBox: bounds,
      metadataBytes: 10,
    }),
  });
  await scheduler.initialized;
  scheduler.update();
  await assert.rejects(
    scheduler.firstRenderable,
    /minimum renderable budget for the current view/,
  );
  assert.equal(loads(), 0);
  assert.equal(scheduler.stats.disposed, true);
});

test("transient failures wake an on-demand loop and retry successfully", async (context) => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let wakes = 0;
  const { scheduler } = schedulerHarness({
    budget: 2,
    extract: async (ranges) => {
      if (++attempts === 1) throw new TypeError("Failed to fetch");
      return ranges.map((range) => ({ numSplats: range.count, extra: {} }));
    },
  });
  context.after(() => scheduler.dispose());
  await scheduler.initialized;
  scheduler.options.onChange = () => {
    wakes++;
    queueMicrotask(() => scheduler.update());
  };
  scheduler.update();
  await flush();
  assert.equal(attempts, 1);
  const beforeRetry = wakes;
  now = 1999;
  context.mock.timers.tick(1999);
  await flush();
  assert.equal(wakes, beforeRetry);
  assert.equal(attempts, 1);
  now = 2000;
  context.mock.timers.tick(1);
  await flush();
  assert.ok(wakes > beforeRetry);
  assert.equal(attempts, 2);
  await scheduler.firstRenderable;
  assert.equal(scheduler.stats.visibleSplats, 2);
});
