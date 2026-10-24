import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { SogRegionSplats } from "../src/data/SogRegionSplats.js";
import { selectLccUnits } from "../src/loaders/stream/lcc-stream/lccScene.js";
import {
  readLcc2Scene,
  selectLcc2Units,
} from "../src/loaders/stream/lcc2-stream/lcc2Scene.js";
import { SceneStreamScheduler } from "../src/loaders/stream/scene-stream/SceneStreamScheduler.js";
import { regionMemory } from "../src/loaders/stream/scene-stream/memory.js";

const bounds = { min: [-1, -1, -3], max: [1, 1, -1] };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function packed(start, count) {
  return {
    numSplats: count,
    splatArrays: [new Uint32Array(count * 4), new Uint32Array(count * 4)],
    sourceIds: Uint32Array.from({ length: count }, (_, i) => start + i),
    spatialBounds: new Float32Array(Math.ceil(count / 256) * 6),
    centerOnlyBoundingBox: [-1, -1, -3, 1, 1, -1],
    boundingBox: [-1, -1, -3, 1, 1, -1],
    extra: {},
  };
}
function harness(context, model, select, options = {}) {
  const batches = [];
  const loads = [];
  const scheduler = new SceneStreamScheduler(
    { url: "https://scene.invalid/scene.lcc2", onError() {}, ...options },
    { name: "batch-test", read: async () => model, select },
    {
      loader: {
        stats: {},
        dispose() {},
        async load(source) {
          loads.push(source.key);
          return {
            dispose() {},
            async extract(ranges) {
              return ranges.map(({ start, count }) => packed(start, count));
            },
          };
        },
      },
      createBatch: async (capacity, degree) => {
        const source = new SogRegionSplats(capacity, degree);
        const slots = new Map();
        const batch = {
          source,
          numSh: degree,
          userData: {},
          layers: new THREE.Layers(),
          visible: true,
          disposed: false,
          writeRegion(start, data) {
            source.write(start, data);
            slots.set(start, data.numSplats);
          },
          setRegionOpacity(start, opacity) {
            source.setOpacity(start, slots.get(start), opacity);
          },
          releaseRegion(start) {
            this.setRegionOpacity(start, 0);
            source.release(start);
            slots.delete(start);
          },
          removeFromParent() {},
          dispose() {
            this.disposed = true;
            source.dispose();
          },
          raycast(_raycaster, hits) {
            for (let index = 0; index < source.getNumSplats(); index++)
              hits.push({
                object: this,
                index,
                sourceIndex: source.getSourceIndex(index),
              });
          },
        };
        batches.push(batch);
        return batch;
      },
    },
  );
  scheduler.setCamera(new THREE.PerspectiveCamera(60, 1, 0.1, 100));
  context.after(async () => {
    scheduler.dispose();
    await tick();
  });
  return { scheduler, batches, loads };
}
async function settle(scheduler, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    scheduler.update();
    await tick();
  }
}

test("staggered cameras cannot fragment slots promised to uneven coarse regions", async (context) => {
  const counts = [5056, 3008, 5056, 3008];
  const positions = [30, 10, 40, 20];
  const model = {
    units: [
      {
        id: "a",
        boundingBox: bounds,
        representations: [
          representation("a-coarse", 1),
          representation("a-fine", 8192),
        ],
      },
      ...counts.map((count, index) => ({
        id: `hidden-${index}`,
        boundingBox: {
          min: [positions[index] - 1, -1, -3],
          max: [positions[index] + 1, 1, -1],
        },
        representations: [representation(`coarse-${index}`, count)],
      })),
    ],
    coarseCount: 16129,
    boundingBox: { min: [-1, -1, -3], max: [41, 1, -1] },
    metadataBytes: 0,
  };
  const { scheduler } = harness(context, model, selectLccUnits, {
    splatBudget: 30000,
    maxResidentGpuBytes: 983040,
  });
  await scheduler.initialized;
  await settle(scheduler);
  assert.equal(scheduler.shown.get("a").rep.id, "a-fine");
  const visible = ["a"];
  for (const index of [1, 3, 0, 2]) {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.x = positions[index];
    camera.updateMatrixWorld();
    scheduler.setCamera(camera);
    await settle(scheduler);
    visible.push(`hidden-${index}`);
    assert.equal(scheduler.jobs.size, 0);
    assert.deepEqual([...scheduler.shown.keys()].sort(), [...visible].sort());
    assert.equal(
      scheduler.shown.get("a").rep.id,
      "a-fine",
      "camera changes must not discard existing coverage",
    );
    assert.ok(scheduler.stats.residentGpuBytes <= 983040);
  }
  assert.equal(scheduler.stats.visibleSplats, 24320);
  assert.equal(scheduler.stats.loadProgress, 1);
  for (const camera of scheduler.cameras) camera.layers.disableAll();
  await settle(scheduler, 2);
  assert.equal(scheduler.stats.residentGpuBytes, 0);
});

test("disposing during shared batch creation retains reservations until late storage is destroyed", async (context) => {
  const shared = source("shared-late", 2);
  const reps = [0, 1].map((start) => ({
    id: `late-${start}`,
    count: 1,
    ranges: [{ source: shared, start, count: 1, node: start }],
  }));
  const model = {
    units: reps.map((rep) => ({
      id: rep.id,
      boundingBox: bounds,
      representations: [rep],
    })),
    coarseCount: 2,
    boundingBox: bounds,
    metadataBytes: 0,
  };
  const { scheduler, batches } = harness(
    context,
    model,
    () => new Map(reps.map((rep) => [rep.id, rep])),
  );
  let finishBatch;
  const waiting = new Promise((resolve) => {
    finishBatch = resolve;
  });
  const create = scheduler.createBatch;
  let creating = false;
  scheduler.createBatch = async (...args) => {
    creating = true;
    await waiting;
    return create(...args);
  };
  await scheduler.initialized;
  scheduler.update();
  await tick();
  assert.equal(creating, true);
  const held = scheduler.stats.residentGpuBytes;
  assert.ok(held > 0);
  scheduler.dispose();
  assert.equal(scheduler.stats.residentGpuBytes, held);
  finishBatch();
  await tick();
  await tick();
  assert.equal(scheduler.stats.visibleSplats, 0);
  assert.ok(batches.every((batch) => batch.disposed));
  assert.equal(scheduler.stats.residentBytes, 0);
});

test("maximum supported source count is not rejected for rounded backing capacity", async (context) => {
  const rep = representation("maximum", 8_000_000);
  const model = {
    units: [{ id: "unit", boundingBox: bounds, representations: [rep] }],
    coarseCount: rep.count,
    boundingBox: bounds,
    metadataBytes: 0,
  };
  const { scheduler } = harness(
    context,
    model,
    () => new Map([["unit", rep]]),
    {
      splatBudget: rep.count,
      maxResidentCpuBytes: Number.POSITIVE_INFINITY,
      maxResidentGpuBytes: Number.POSITIVE_INFINITY,
    },
  );
  await scheduler.initialized;
});

test("shared slots distinguish overlapping file IDs and replace stale picking metadata on reuse", async (context) => {
  const reps = ["a", "b", "c"].map((id) => representation(id, 1));
  let selected = new Map([
    ["a", reps[0]],
    ["b", reps[1]],
  ]);
  const model = {
    units: reps.map((rep) => ({
      id: rep.id,
      boundingBox: bounds,
      representations: [rep],
    })),
    coarseCount: 3,
    boundingBox: bounds,
    metadataBytes: 0,
  };
  const { scheduler, batches } = harness(
    context,
    model,
    () => new Map(selected),
  );
  await scheduler.initialized;
  await settle(scheduler);
  const pick = () => {
    const hits = [];
    for (const batch of batches.filter((batch) => !batch.disposed))
      batch.raycast({}, hits);
    return hits;
  };
  assert.deepEqual(
    pick().map((hit) => [hit.sourceIndex, hit.sceneStream.resource]),
    [
      [0, "https://scene.invalid/a.ply"],
      [0, "https://scene.invalid/b.ply"],
    ],
  );
  selected = new Map([
    ["b", reps[1]],
    ["c", reps[2]],
  ]);
  await settle(scheduler);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    pick().map((hit) => [hit.sourceIndex, hit.sceneStream.resource]),
    [
      [0, "https://scene.invalid/b.ply"],
      [0, "https://scene.invalid/c.ply"],
    ],
  );
});

test("scheduler diagnostics count source and GPU reservations, cached buffers, and failed detail", async (context) => {
  let finishLoad;
  let finishExtract;
  const loaded = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const extracted = new Promise((resolve) => {
    finishExtract = resolve;
  });
  const coarse = representation("coarse", 2);
  const fine = {
    ...representation("fine", 8),
    ranges: [{ ...coarse.ranges[0], count: 8 }],
  };
  const model = {
    units: [
      { id: "unit", boundingBox: bounds, representations: [coarse, fine] },
    ],
    coarseCount: 2,
    boundingBox: bounds,
    metadataBytes: 0,
  };
  const { scheduler } = harness(context, model, selectLccUnits);
  scheduler.loader.load = async () => {
    await loaded;
    return {
      info: { byteLength: 44 },
      dispose() {},
      async extract(ranges) {
        await extracted;
        if (ranges[0].count === 8) throw new Error("Invalid fine payload");
        return ranges.map(({ start, count }) => packed(start, count));
      },
    };
  };
  await scheduler.initialized;
  scheduler.update();
  await tick();
  assert.equal(
    scheduler.stats.pendingBytes,
    scheduler.memory.cpu + scheduler.memory.gpu,
  );
  assert.equal(scheduler.stats.failedNodes, 0);
  finishLoad();
  await tick();
  assert.equal(scheduler.stats.cachedBytes, 44);
  finishExtract();
  await settle(scheduler, 5);
  assert.equal(scheduler.stats.failedNodes, 1);
  assert.equal(scheduler.stats.visibleSplats, 2);
  assert.equal(scheduler.stats.pendingBytes, 0);
});
const source = (key, count, degree = 0) => ({
  key,
  url: `https://scene.invalid/${key}.ply`,
  codec: "ply",
  count,
  shDegree: degree,
  sourceOffset: 0,
});
const representation = (id, count) => ({
  id,
  count,
  ranges: [{ source: source(id, count), start: 0, count, node: id }],
});

for (const format of ["LCC", "LCC2"]) {
  test(`${format} cannot spend missing coarse coverage on early refinement or camera changes`, async (context) => {
    let model;
    let select;
    if (format === "LCC") {
      model = {
        units: [
          {
            id: "a",
            boundingBox: bounds,
            representations: [
              representation("a-coarse", 8192),
              representation("a-fine", 16384),
            ],
          },
          ...["b", "c"].map((id) => ({
            id,
            boundingBox: bounds,
            representations: [representation(`${id}-coarse`, 8192)],
          })),
        ],
        coarseCount: 24576,
        boundingBox: bounds,
        metadataBytes: 0,
      };
      select = selectLccUnits;
    } else {
      const payload = (start, count, name = 0) => ({
        "3dgs": { name, start, count },
      });
      const manifest = {
        version: "0.0.3",
        splatType: ".ply",
        totalLevels: 2,
        totalSplats: 40960,
        lodSplats: [16384, 24576],
        root: {
          id: "root",
          boundingBox: bounds,
          splatFiles: ["a.ply", "b.ply", "c.ply"],
          childNum: 3,
          child: [
            {
              id: "a",
              boundingBox: bounds,
              data: payload(0, 8192),
              childNum: 1,
              child: [
                {
                  id: "a-fine",
                  boundingBox: bounds,
                  data: payload(8192, 16384),
                  childNum: 0,
                },
              ],
            },
            {
              id: "b",
              boundingBox: bounds,
              data: payload(0, 8192, 1),
              childNum: 0,
            },
            {
              id: "c",
              boundingBox: bounds,
              data: payload(0, 8192, 2),
              childNum: 0,
            },
          ],
        },
      };
      context.mock.method(
        globalThis,
        "fetch",
        async () => new Response(JSON.stringify(manifest)),
      );
      model = await readLcc2Scene(
        { url: "https://scene.invalid/model.lcc2" },
        new AbortController().signal,
      );
      // The fixture's actual payloads contain SH0, as does this controlled extractor.
      for (const unit of model.units)
        for (const rep of unit.representations)
          for (const range of rep.ranges) range.source.shDegree = 0;
      select = selectLcc2Units;
    }
    const { scheduler } = harness(context, model, select, {
      splatBudget: 50000,
      maxResidentGpuBytes: regionMemory(8192, 0).gpu * 3,
    });
    await scheduler.initialized;
    await settle(scheduler);
    assert.equal(scheduler.shown.size, 3);
    assert.equal(scheduler.stats.visibleSplats, 24576);
    for (const unit of model.units.slice(1))
      unit.boundingBox = { min: [99, -1, -3], max: [101, 1, -1] };
    await settle(scheduler);
    assert.equal(scheduler.shown.size, 1);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.x = 100;
    camera.updateMatrixWorld();
    scheduler.setCamera(camera);
    await settle(scheduler);
    assert.equal(scheduler.shown.size, 3);
    assert.equal(scheduler.stats.visibleSplats, 24576);
    assert.ok(scheduler.stats.residentGpuBytes <= scheduler.memory.maxGpu);
  });
}

test("1000 one-splat leaves share real backing storage and keep per-range picking identity", async (context) => {
  const manifest = {
    version: "0.0.3",
    splatType: ".ply",
    totalLevels: 1,
    totalSplats: 1000,
    lodSplats: [1000],
    root: {
      id: "root",
      boundingBox: bounds,
      childNum: 1000,
      splatFiles: ["shared.ply"],
      child: Array.from({ length: 1000 }, (_, start) => ({
        id: `leaf-${start}`,
        boundingBox: bounds,
        childNum: 0,
        data: { "3dgs": { name: 0, start, count: 1 } },
      })),
    },
  };
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(manifest)),
  );
  const model = await readLcc2Scene(
    { url: "https://scene.invalid/model.lcc2" },
    new AbortController().signal,
  );
  const { scheduler, batches } = harness(context, model, selectLcc2Units);
  await scheduler.initialized;
  await settle(scheduler);
  assert.equal(scheduler.stats.visibleSplats, 1000);
  assert.ok(
    batches.length <= 8,
    "64-record slots must share 8192-record backing pages",
  );
  assert.equal(scheduler.stats.residentMeshes, batches.length);
  assert.ok(
    batches.reduce((sum, batch) => sum + batch.source.textureByteLength, 0) <
      16 * 1024 ** 2,
  );
  const hits = [];
  for (const batch of batches) batch.raycast({}, hits);
  assert.equal(hits.length, 1000);
  for (const hit of hits) {
    assert.equal(hit.sceneStream.node.id, `leaf-${hit.sourceIndex}`);
    assert.equal(hit.sceneStream.start, hit.sourceIndex);
    assert.equal(hit.sceneStream.resource, "https://scene.invalid/shared.ply");
  }
  const select = scheduler.adapter.select;
  scheduler.adapter.select = (...args) =>
    new Map([...select(...args)].filter(([, rep]) => rep.ranges[0].start % 2));
  await settle(scheduler, 2);
  assert.equal(scheduler.stats.visibleSplats, 500);
  assert.ok(
    batches.every((batch) => !batch.disposed),
    "releasing one slot cannot dispose its visible neighbours",
  );
  const remaining = [];
  for (const batch of batches) batch.raycast({}, remaining);
  assert.equal(remaining.length, 500);
  assert.ok(
    remaining.every(
      (hit) => hit.sourceIndex % 2 && hit.sceneStream.start === hit.sourceIndex,
    ),
  );
  const survivor = batches[0];
  scheduler.cameras[0].layers.disableAll();
  await settle(scheduler, 2);
  assert.equal(survivor.disposed, true);
  assert.equal(scheduler.stats.residentGpuBytes, 0);
});
