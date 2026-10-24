import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LoadingManager } from "three";
import { parseLcc2Manifest } from "../src/loaders/lcc2/lcc2Manifest.js";
import {
  readLcc2Scene,
  selectLcc2Units,
} from "../src/loaders/stream/lcc2-stream/lcc2Scene.js";
import { sourceMemory } from "../src/loaders/stream/scene-stream/memory.js";

const url = "https://example.test/scene/model.lcc2";
const bounds = { min: [-1, -2, -3], max: [1, 2, 3] };
function node(id, count, children = []) {
  return {
    id,
    boundingBox: structuredClone(bounds),
    childNum: children.length,
    child: Object.fromEntries(
      children.map((child, index) => [`slot-${index}`, child]),
    ),
    ...(count === undefined
      ? {}
      : { data: { "3dgs": { name: 0, start: 0, count } } }),
  };
}
function fixture(
  root = node("root", undefined, [
    node("unrelated-A", 2, [
      node("opaque:first", 3, [
        node("not-a-path", 4),
        node("also-not-a-path", 4),
      ]),
      node("opaque:second", 3),
      node("opaque:third", 3),
    ]),
    node("unrelated-B", 2, [
      node("west", 3),
      node("east", 3),
      node("south", 3),
    ]),
  ]),
) {
  let end = 0;
  const counts = [];
  const visit = (current, level) => {
    const ref = current.data?.["3dgs"];
    if (ref) {
      ref.start = end;
      end += ref.count + 3;
      counts[level] = (counts[level] ?? 0) + ref.count;
    }
    for (const child of Object.values(current.child))
      visit(child, level + Number(!!ref));
  };
  visit(root, 0);
  if (!counts.length) counts.push(0);
  root.splatFiles = ["nested/shared.spz", "nested/./shared.spz"];
  return {
    version: "0.0.3",
    splatType: ".spz",
    totalLevels: counts.length,
    totalSplats: counts.reduce((sum, count) => sum + count, 0),
    lodSplats: counts.toReversed(),
    offset: [1000, 2000, 3000],
    shift: [4, 5, 6],
    scale: [2, 3, 4],
    virtualLoD: { levels: 2, method: "reserved" },
    renderingHints: { cameraModel: "reserved" },
    root,
  };
}
async function read(context, metadata, options = {}) {
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(metadata)),
  );
  return readLcc2Scene({ url, ...options }, new AbortController().signal);
}
function scores(model, distance = 1) {
  return new Map(model.units.map((unit) => [unit.id, distance]));
}
function shown(selection) {
  return new Map([...selection].map(([id, rep]) => [id, { rep }]));
}
function total(selection) {
  return [...selection.values()].reduce((sum, rep) => sum + rep.count, 0);
}
function assertComplete(model, selection) {
  for (const unit of model.units) {
    const rep = selection.get(unit.id);
    if (!rep) continue;
    const ids = new Set(rep.nodeIds);
    const consumed = new Set();
    const visit = (current, ancestorSelected = false) => {
      const selected = ids.has(current.id);
      assert.ok(
        !(selected && ancestorSelected),
        "ancestor and descendant must never coexist",
      );
      if (selected) consumed.add(current.id);
      const childrenComplete = current.children
        .map((child) => visit(child, ancestorSelected || selected))
        .every(Boolean);
      return (
        selected ||
        (current.children.length > 0 && childrenComplete) ||
        current.payload?.count === 0
      );
    };
    assert.ok(
      visit(unit.refinementRoot),
      "replacement frontier must cover the whole branch",
    );
    assert.deepEqual(consumed, ids);
    assert.equal(
      rep.count,
      rep.ranges.reduce((sum, range) => sum + range.count, 0),
    );
  }
}

test("LCC2 admits complete coarse coverage before multilevel N-ary budget cuts", async (context) => {
  const metadata = fixture();
  const cpuBudget = 512 * 1024 * 1024;
  const model = await read(context, metadata, {
    refinement: "replace",
    maxResidentCpuBytes: cpuBudget,
  });
  assert.equal(model.coarseCount, 4);
  assert.equal(
    model.metadataBytes,
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength,
  );
  assert.ok(
    sourceMemory(model.units[0].representations[0].ranges[0].source) <
      cpuBudget,
  );
  assert.equal(model.units.length, 2);
  assert.equal(model.units[0].refinementRoot.children.length, 3);
  const distances = scores(model);
  const cold = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    distances,
  );
  assert.equal(
    total(cold),
    4,
    "first selection must be coarse even with an unlimited budget",
  );
  const expected = new Map([
    [4, [2, 2]],
    [11, [9, 2]],
    [16, [14, 2]],
    [23, [14, 9]],
  ]);
  for (const [budget, counts] of expected) {
    const selected = selectLcc2Units(
      model.units,
      budget,
      distances,
      shown(cold),
    );
    assert.deepEqual(
      [...selected.values()].map((rep) => rep.count),
      counts,
    );
    assert.ok(total(selected) <= budget);
    assertComplete(model, selected);
  }
  assertComplete(model, cold);
  const nearest = selectLcc2Units(
    model.units,
    11,
    new Map([
      [model.units[0].id, 20],
      [model.units[1].id, 1],
    ]),
    shown(cold),
  );
  assert.equal(nearest.get(model.units[1].id).count, 9);
  assert.equal(nearest.get(model.units[0].id).count, 2);
  const limited = selectLcc2Units(model.units, 2, distances, shown(cold));
  assert.equal(limited.size, 1);
  assert.equal(total(limited), 2);
});

test("LCC2 emits stable cut IDs and retains distance bands with hysteresis", async (context) => {
  const model = await read(context, fixture());
  const coarse = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    scores(model),
  );
  const options = { lodDistances: [10, 5], lodHysteresis: 0.2 };
  const select = (distance, previous = coarse) =>
    selectLcc2Units(
      model.units,
      Number.POSITIVE_INFINITY,
      scores(model, distance),
      shown(previous),
      options,
    );
  assert.equal(
    total(select(9)),
    4,
    "do not enter the hysteresis band from coarse",
  );
  const medium = select(7);
  assert.equal(total(medium), 18);
  assert.equal(total(select(11, medium)), 18);
  assert.equal(total(select(13, medium)), 4);
  const fine = select(3, medium);
  assert.equal(total(fine), 23);
  assert.deepEqual(
    [...select(3, fine).values()].map((rep) => rep.id),
    [...fine.values()].map((rep) => rep.id),
  );
  assert.equal(total(select(5.5, fine)), 23);
  assert.equal(total(select(6.5, fine)), 18);
  assertComplete(model, fine);
  assert.equal(
    selectLcc2Units(
      model.units,
      Number.POSITIVE_INFINITY,
      new Map(),
      shown(fine),
      options,
    ).size,
    0,
  );
  assert.throws(
    () =>
      selectLcc2Units(model.units, 10, scores(model), shown(coarse), {
        lodDistances: [1, 2],
      }),
    /lodDistances/,
  );
  assert.throws(
    () =>
      selectLcc2Units(model.units, 10, scores(model), shown(coarse), {
        lodHysteresis: 1,
      }),
    /lodHysteresis/,
  );
});

test("LCC2 traverses payload-free connectors without consuming a payload level", async (context) => {
  const metadata = fixture(
    node("root", undefined, [
      node("branch", undefined, [
        node("connector", undefined, [
          node("a", 2, [node("fine-a", 5)]),
          node("b", 3),
        ]),
      ]),
    ]),
  );
  const model = await read(context, metadata);
  assert.deepEqual(
    model.boundingBox,
    bounds,
    "reserved transforms must not be applied",
  );
  assert.equal(model.units.length, 1);
  const coarse = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    scores(model),
  );
  assert.deepEqual([...coarse.values()][0].nodeIds, ["a", "b"]);
  assert.equal([...coarse.values()][0].level, 0);
  const refined = selectLcc2Units(model.units, 8, scores(model), shown(coarse));
  assert.deepEqual([...refined.values()][0].nodeIds, ["fine-a", "b"]);
  assert.deepEqual(
    [...refined.values()][0].ranges.map((range) => range.start),
    [5, 13],
  );
  assertComplete(model, refined);
});

test("LCC2 retains parent when any child has no complete payload frontier", async (context) => {
  const metadata = fixture(
    node("root", 2, [node("available", 4), node("missing", undefined)]),
  );
  const model = await read(context, metadata);
  assert.equal(
    model.units.length,
    1,
    "payload-bearing root is a single coverage unit",
  );
  const coarse = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    scores(model),
  );
  const selected = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    scores(model),
    shown(coarse),
  );
  assert.deepEqual([...selected.values()][0].nodeIds, ["root"]);
  assert.equal(total(selected), 2);
  assertComplete(model, selected);
});

test("LCC2 validates aggregate payload totals, never count-only LOD or ID-derived levels", async (context) => {
  const metadata = fixture();
  metadata.lodSplats[1]++;
  await assert.rejects(
    read(context, metadata),
    /payload-level totals.*reversed lodSplats/,
  );
  const leaves = await read(context, metadata, { refinement: "leaves" });
  assert.equal(leaves.units.length, 7);
  const selection = selectLcc2Units(
    leaves.units,
    Number.POSITIVE_INFINITY,
    scores(leaves),
  );
  assert.equal(total(selection), 23);
  assert.ok([...selection.values()].every((rep) => rep.ranges.length === 1));
  metadata.root.child["slot-0"].data = [metadata.root.child["slot-0"].data];
  await assert.rejects(
    read(context, metadata, { refinement: "leaves" }),
    /array-valued data/,
  );
  await assert.rejects(
    read(context, fixture(), { refinement: "additive" }),
    /refinement must be/,
  );
});

test("LCC2 source deduplication preserves all referenced ends and range order", async (context) => {
  const metadata = fixture();
  metadata.root.child["slot-1"].data["3dgs"].name = 1;
  metadata.root.child["slot-0"].data["3dgs"].start = 500;
  metadata.root.child["slot-0"].child["slot-0"].child["slot-0"].data[
    "3dgs"
  ].start = 300;
  const model = await read(context, metadata);
  const coarse = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    scores(model),
  );
  const fine = selectLcc2Units(
    model.units,
    Number.POSITIVE_INFINITY,
    scores(model),
    shown(coarse),
  );
  const ranges = [...fine.values()].flatMap((rep) => rep.ranges);
  assert.equal(new Set(ranges.map((range) => range.source)).size, 1);
  assert.equal(ranges[0].source.count, 502);
  assert.equal(ranges[0].source.shDegree, 4);
  assert.equal(
    ranges[0].source.url,
    "https://example.test/scene/nested/shared.spz",
  );
  assert.deepEqual(
    ranges.map((range) => range.start),
    [300, 18, 25, 31, 42, 48, 54],
  );
});

test("LCC2 supports empty scenes, explicit empty payloads and actual single-level leaves", async (context) => {
  for (const root of [node("empty", undefined), node("zero", 0)]) {
    const model = await read(context, fixture(root));
    assert.deepEqual(model.units, []);
    assert.equal(selectLcc2Units(model.units, 0, new Map()).size, 0);
  }
  const root = await read(context, fixture(node("single", 4)));
  assert.equal(root.units.length, 1);
  assert.equal(total(selectLcc2Units(root.units, 4, scores(root))), 4);
  const leaves = await read(
    context,
    fixture(node("root", undefined, [node("one", 5), node("two", 5)])),
  );
  assert.equal(leaves.units.length, 2);
  const coarse = selectLcc2Units(leaves.units, 10, scores(leaves));
  assert.equal(
    total(selectLcc2Units(leaves.units, 10, scores(leaves), shown(coarse))),
    10,
  );
  const nearest = selectLcc2Units(
    leaves.units,
    5,
    new Map([
      [leaves.units[0].id, 10],
      [leaves.units[1].id, 1],
    ]),
  );
  assert.deepEqual([...nearest.keys()], [leaves.units[1].id]);
  assert.equal(total(nearest), 5);
  assert.equal(
    selectLcc2Units(leaves.units, 4, new Map([[leaves.units[0].id, 1]])).size,
    0,
  );
});

test("LCC2 rejects incomplete coarse coverage instead of silently dropping a branch", async (context) => {
  const metadata = fixture(
    node("root", undefined, [
      node("branch", undefined, [node("known", 2), node("unknown", undefined)]),
    ]),
  );
  await assert.rejects(read(context, metadata), /complete coarse frontier/);
  const leaves = await read(context, metadata, { refinement: "leaves" });
  assert.equal(leaves.units.length, 1);
});

test("LCC2 keeps logical nested paths, deduplicates sources, and rejects array-valued data", async (context) => {
  const leaf = (id, start) => ({
    id,
    boundingBox: bounds,
    childNum: 0,
    data: { "3dgs": { name: 0, start, count: 2 } },
  });
  const metadata = {
    version: "0.0.3",
    splatType: ".spz",
    totalLevels: 1,
    totalSplats: 4,
    lodSplats: [4],
    env: { type: "splats", splatsCount: 4, boundingBox: bounds },
    root: {
      id: "root",
      boundingBox: bounds,
      childNum: 2,
      child: [leaf("a", 0), leaf("b", 5)],
      data: { env: { name: 1 }, "3dgs": { name: 0, start: 10, count: 2 } },
      splatFiles: ["nested/shared.spz", "sky.spz"],
    },
  };
  const manager = new LoadingManager();
  manager.setURLModifier(() => "blob:https://local.invalid/root");
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "blob:https://local.invalid/root");
    return new Response(JSON.stringify(metadata));
  });
  const options = {
    url: "https://local.invalid/folder/scene.lcc2",
    manager,
    refinement: "leaves",
  };
  const model = await readLcc2Scene(options, new AbortController().signal);
  assert.equal(model.units.length, 2);
  const ranges = model.units.map((unit) => unit.representations[0].ranges[0]);
  assert.equal(ranges[0].source, ranges[1].source);
  assert.equal(
    ranges[0].source.url,
    "https://local.invalid/folder/nested/shared.spz",
  );
  assert.equal(
    ranges[0].source.count,
    12,
    "interior ranges bound source count without being rendered",
  );
  assert.equal(
    model.environment.ranges[0].source.url,
    "https://local.invalid/folder/sky.spz",
  );
  metadata.root.child[0].data = [metadata.root.child[0].data];
  await assert.rejects(
    readLcc2Scene(options, new AbortController().signal),
    /ambiguous refinement/,
  );
});

const sampleManifest = process.env.LCC2_SAMPLE;
// Private exports stay outside the repository; only aggregate summaries are reported.
test(
  "real LCC2 export verifies payload-level replacement profile",
  { skip: !sampleManifest },
  async (context) => {
    const metadata = JSON.parse(await readFile(sampleManifest, "utf8"));
    const manifest = parseLcc2Manifest(metadata, url);
    const counts = [];
    const visit = (current, level) => {
      const refs = current.references.filter((ref) => ref.kind === "3dgs");
      if (refs.length)
        counts[level] =
          (counts[level] ?? 0) + refs.reduce((sum, ref) => sum + ref.count, 0);
      for (const child of current.children)
        visit(child, level + Number(refs.length > 0));
    };
    visit(manifest.tree, 0);
    assert.deepEqual(counts.toReversed(), metadata.lodSplats);
    const model = await read(context, metadata);
    const coarse = selectLcc2Units(
      model.units,
      Number.POSITIVE_INFINITY,
      scores(model),
    );
    assert.equal(total(coarse), counts[0]);
    const fine = selectLcc2Units(
      model.units,
      Number.POSITIVE_INFINITY,
      scores(model),
      shown(coarse),
    );
    assert.equal(total(fine), counts.at(-1));
    assertComplete(model, fine);
    context.diagnostic(
      JSON.stringify({
        nodes: manifest.nodes.length,
        coverageUnits: model.units.length,
        payloadCounts: counts,
      }),
    );
  },
);
