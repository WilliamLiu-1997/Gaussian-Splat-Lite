import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLcc2Bytes,
  parseLcc2Manifest,
} from "../src/loaders/lcc2/lcc2Manifest.js";

const baseUrl = "https://example.test/scenes/scene.lcc2?token=scene";
const box = () => ({ min: [-1, -2, -3], max: [1, 2, 3] });
const splats = (start = 0, count = 3, name = 0) => ({
  "3dgs": { name, start, count },
});
const node = (id, data = splats()) => ({
  id,
  boundingBox: box(),
  childNum: 0,
  data,
});
function fixture(codec = "spz") {
  return {
    version: "0.0.3",
    splatType: `.${codec}`,
    totalLevels: 2,
    totalSplats: 30,
    lodSplats: [20, 10],
    offset: [7, 8, 9],
    shift: [1, 2, 3],
    scale: [2, 3, 4],
    virtualLoD: { levels: 1, method: "simple" },
    renderingHints: { cameraModel: "pinhole" },
    env: { type: "splats", splatsCount: 4, boundingBox: box() },
    root: {
      ...node("root", { env: { name: 1 } }),
      childNum: 3,
      child: {
        north: node("unrelated-id", splats(7, 2)),
        west: node("second", splats(1, 3)),
        south: node("third", {
          ...splats(7, 2),
          mesh: { name: 0, vertex: 8, face: 4 },
          bvh: { name: 0 },
          semantic: { custom: true },
        }),
      },
      splatFiles: [`data/shared.${codec}`, `data/env.${codec}`],
      meshFiles: ["meshes/collision.ply"],
      bvhFiles: ["meshes/collision.btree"],
    },
  };
}
function rejects(edit, pattern) {
  const source = fixture();
  edit(source);
  assert.throws(() => parseLcc2Manifest(source, baseUrl), pattern);
}

test("LCC2 normalizes N-ary collections, shared intervals and explicit environment", () => {
  const source = fixture();
  const original = structuredClone(source);
  const result = parseLcc2Manifest(source, baseUrl);
  assert.deepEqual(source, original);
  assert.equal(result.metadata, source);
  assert.deepEqual(result.lodSplats, [20, 10]);
  assert.equal(result.totalLevels, 2);
  assert.equal(result.totalSplats, 30);
  assert.deepEqual(result.tree.boundingBox, box());
  assert.deepEqual(
    result.tree.children.map((child) => child.id),
    ["unrelated-id", "second", "third"],
  );
  assert.equal(result.nodes.length, 4);
  assert.deepEqual(
    result.files.map((file) => [file.id, file.kind, file.index]),
    [
      [0, "3dgs", 0],
      [1, "3dgs", 1],
      [2, "mesh", 0],
      [3, "bvh", 0],
    ],
  );
  assert.equal(
    result.files[0].url,
    "https://example.test/scenes/data/shared.spz",
  );
  assert.deepEqual(
    result.references
      .filter((reference) => reference.kind === "3dgs")
      .map(({ file, start, count, dataIndex }) => [
        file,
        start,
        count,
        dataIndex,
      ]),
    [
      [0, 7, 2, undefined],
      [0, 1, 3, undefined],
      [0, 7, 2, undefined],
    ],
  );
  assert.equal(result.environment.reference.file, 1);
  assert.equal(result.environment.count, 4);
  assert.equal(result.environment.metadata, source.env);
  assert.deepEqual(result.environment.boundingBox, box());
  assert.equal(result.tree.children[2].references[1].vertex, 8);
  assert.equal(result.tree.children[2].references[2].file, 3);
  assert.equal(result.tree.children[2].data.semantic.custom, true);
  assert.deepEqual(result.tree.lods, []);
});

test("LCC2 keeps interior payloads, exported LOD arrays and original metadata", () => {
  const source = fixture();
  const branch = source.root.child.north;
  branch.data = [splats(17, 3), splats(0, 0), { custom: "empty level" }];
  branch.childNum = 1;
  branch.child = { arbitrary: node("deeper", splats(5, 1)) };
  const result = parseLcc2Manifest(source, baseUrl);
  const normalized = result.tree.children[0];
  assert.equal(normalized.data, branch.data);
  assert.equal(normalized.metadata, branch);
  assert.deepEqual(
    normalized.lods.map(({ level }) => level),
    [0, 1, 2],
  );
  assert.equal(normalized.lods[0].data, branch.data[0]);
  assert.equal(normalized.references[0].dataIndex, 0);
  assert.equal(normalized.references[1].dataIndex, 1);
  assert.equal(normalized.references[1].count, 0);
  assert.deepEqual(normalized.lods[2].references, []);
  assert.equal(normalized.children[0].depth, 2);
  assert.equal(normalized.children[0].references[0].dataIndex, undefined);
  assert.equal(result.metadata.virtualLoD, source.virtualLoD);
  assert.equal(result.metadata.renderingHints, source.renderingHints);
});

test("LCC2 supports each documented codec and URL-relative paths", () => {
  for (const codec of ["ply", "spz", "sog"]) {
    const source = fixture(codec);
    source.root.splatFiles[0] = `../shared/points.${codec}?signed=1#payload`;
    source.root.child = Object.values(source.root.child);
    const result = parseLcc2Manifest(source, baseUrl);
    assert.equal(result.files[0].codec, codec);
    assert.equal(
      result.files[0].url,
      `https://example.test/shared/points.${codec}?signed=1#payload`,
    );
    assert.equal(result.files[0].path, source.root.splatFiles[0]);
  }
  const result = parseLcc2Manifest(fixture(), "file:///folder/scene.lcc2");
  assert.equal(result.files[0].url, "file:///folder/data/shared.spz");
});

test("LCC2 does not guess an environment filename or invent missing payloads", () => {
  const source = fixture();
  source.root.data = null;
  source.root.child.north.data = null;
  const result = parseLcc2Manifest(source, baseUrl);
  assert.equal(result.environment.reference, undefined);
  assert.equal(result.environment.count, 4);
  assert.deepEqual(result.tree.children[0].references, []);
  source.env = null;
  assert.equal(parseLcc2Manifest(source, baseUrl).environment, undefined);
  source.root.data = { env: { name: 1 } };
  const referenceOnly = parseLcc2Manifest(source, baseUrl).environment;
  assert.equal(referenceOnly.reference.file, 1);
  assert.equal(referenceOnly.count, undefined);
});

test("LCC2 rejects unsupported profiles, codecs, malformed file tables and URLs", () => {
  rejects((m) => {
    m.version = "0.0.4";
  }, /unsupported version/);
  rejects((m) => {
    m.splatType = ".rad";
  }, /unsupported splatType/);
  rejects((m) => {
    m.root.splatFiles = {};
  }, /splatFiles must be an array/);
  rejects((m) => {
    m.root.splatFiles[0] = "points.rad";
  }, /unsupported 3dgs codec/);
  rejects((m) => {
    m.root.splatFiles[0] = "points.ply";
  }, /does not match/);
  rejects((m) => {
    m.root.meshFiles[0] = "mesh.spz";
  }, /unsupported mesh codec/);
  rejects((m) => {
    m.root.bvhFiles[0] = "mesh.ply";
  }, /unsupported bvh codec/);
  rejects((m) => {
    m.root.splatFiles[0] = "data:points.spz";
  }, /protocol/);
  rejects((m) => {
    m.root.splatFiles[0] = "";
  }, /file path/);
  rejects((m) => {
    m.root.splatFiles[0] = "bad\npath.spz";
  }, /file path/);
  assert.throws(
    () => parseLcc2Manifest(fixture(), "not a URL"),
    /cannot resolve/,
  );
});

test("LCC2 validates finite ordered bounds and reserved vectors without applying them", () => {
  rejects((m) => {
    m.root.boundingBox.min[0] = 2;
  }, /min exceeds max/);
  rejects((m) => {
    m.root.boundingBox.max = [1, 2];
  }, /three finite numbers/);
  rejects((m) => {
    m.root.child.north.boundingBox.min[1] = Number.NaN;
  }, /finite JSON/);
  rejects((m) => {
    m.env.boundingBox.max[2] = -4;
  }, /min exceeds max/);
  rejects((m) => {
    m.scale = [1, 1, Number.POSITIVE_INFINITY];
  }, /finite JSON/);
  rejects((m) => {
    m.shift = [1, 1];
  }, /three finite numbers/);
  // Do not silently enlarge parent bounds or apply scale/offset/shift.
  const source = fixture();
  source.root.child.north.boundingBox.max[0] = 100;
  assert.deepEqual(parseLcc2Manifest(source, baseUrl).tree.boundingBox, box());
});

test("LCC2 validates ids and actual child collections, not naming conventions", () => {
  rejects((m) => {
    m.root.id = 0;
  }, /node id/);
  rejects((m) => {
    m.root.id = " ";
  }, /node id/);
  rejects((m) => {
    m.root.child.north.id = "second";
  }, /duplicate node id/);
  rejects((m) => {
    m.root.childNum = 2;
  }, /childNum mismatch/);
  rejects((m) => {
    m.root.childNum = -1;
  }, /safe integer/);
  rejects((m) => {
    m.root.child = "children";
  }, /child collection/);
  rejects((m) => {
    m.root.child.north.childNum = 1;
  }, /childNum mismatch/);
  rejects((m) => {
    m.root.child.north.child = { hidden: node("hidden") };
  }, /childNum mismatch/);
});

test("LCC2 validates all reference indices and safe integer intervals", () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    rejects((m) => {
      m.root.child.north.data["3dgs"].start = value;
    }, /safe integer/);
    rejects((m) => {
      m.root.child.north.data["3dgs"].count = value;
    }, /safe integer/);
    rejects((m) => {
      m.root.child.north.data["3dgs"].name = value;
    }, /safe integer/);
  }
  rejects((m) => {
    m.root.child.north.data["3dgs"].start = Number.MAX_SAFE_INTEGER;
  }, /range end/);
  rejects((m) => {
    m.root.child.north.data["3dgs"].name = 2;
  }, /file index out of bounds/);
  rejects((m) => {
    m.root.child.south.data.mesh.name = 1;
  }, /mesh file index out of bounds/);
  rejects((m) => {
    m.root.child.south.data.bvh.name = 1;
  }, /bvh file index out of bounds/);
  rejects((m) => {
    m.root.data.env.name = 2;
  }, /env file index out of bounds/);
  rejects((m) => {
    m.root.child.south.data.mesh.vertex = -1;
  }, /mesh vertex count/);
  rejects((m) => {
    m.root.child.south.data.mesh.face = 0.5;
  }, /mesh face count/);
  rejects((m) => {
    m.root.child.north.data = { env: { name: 1 } };
  }, /once on root/);
  rejects((m) => {
    m.root.child.north.data = [null];
  }, /data must be an object/);
  rejects((m) => {
    m.root.child.north.data["3dgs"] = null;
  }, /reference must be an object/);
});

test("LCC2 validates declared LOD and environment counts without requiring a partition", () => {
  rejects((m) => {
    m.totalLevels = 0;
  }, /totalLevels must be positive/);
  rejects((m) => {
    m.totalSplats = -1;
  }, /totalSplats/);
  rejects((m) => {
    m.lodSplats = [30];
  }, /totalLevels counts/);
  rejects((m) => {
    m.lodSplats[1] = 1.5;
  }, /lodSplats count/);
  rejects((m) => {
    m.env.type = "texture";
  }, /unsupported env type/);
  rejects((m) => {
    m.env.splatsCount = -1;
  }, /env splatsCount/);
});

test("LCC2 enforces node, depth and exact compact JSON byte budgets", () => {
  const source = fixture();
  const bytes = new TextEncoder().encode(JSON.stringify(source)).byteLength;
  assert.equal(
    parseLcc2Manifest(source, baseUrl, { maxBytes: bytes }).nodes.length,
    4,
  );
  assert.throws(
    () => parseLcc2Manifest(source, baseUrl, { maxBytes: bytes - 1 }),
    /maxBytes/,
  );
  assert.equal(
    parseLcc2Manifest(source, baseUrl, { maxNodes: 4, maxDepth: 1 }).nodes
      .length,
    4,
  );
  assert.throws(
    () => parseLcc2Manifest(source, baseUrl, { maxNodes: 3 }),
    /maxNodes/,
  );
  assert.throws(
    () => parseLcc2Manifest(source, baseUrl, { maxDepth: 0 }),
    /maxDepth/,
  );
  for (const options of [{ maxBytes: 0 }, { maxNodes: -1 }, { maxDepth: 0.5 }])
    assert.throws(
      () => parseLcc2Manifest(source, baseUrl, options),
      /maxBytes|maxNodes|maxDepth/,
    );
  source.unknown = "€\n😀";
  const utf8Bytes = new TextEncoder().encode(JSON.stringify(source)).byteLength;
  assert.equal(
    parseLcc2Manifest(source, baseUrl, { maxBytes: utf8Bytes }).metadata,
    source,
  );
  assert.throws(
    () => parseLcc2Manifest(source, baseUrl, { maxBytes: utf8Bytes - 1 }),
    /maxBytes/,
  );
  source.unknown = { loop: source };
  assert.throws(() => parseLcc2Manifest(source, baseUrl), /cyclic JSON/);
});

test("LCC2 bounds unknown metadata, rejects non-JSON input and walks deep trees iteratively", () => {
  const source = fixture();
  const bytes = new TextEncoder().encode(JSON.stringify(source)).byteLength;
  source.unknown = "a".repeat(1024);
  assert.throws(
    () => parseLcc2Manifest(source, baseUrl, { maxBytes: bytes }),
    /maxBytes/,
  );
  rejects((m) => {
    m.unknown = undefined;
  }, /finite JSON/);
  rejects((m) => {
    m.unknown = new Date();
  }, /plain JSON/);
  rejects((m) => {
    m.unknown = new Array(3);
  }, /finite JSON/);
  rejects((m) => {
    m.unknown = 1n;
  }, /finite JSON/);
  source.unknown = source.root.boundingBox;
  assert.equal(
    parseLcc2Manifest(source, baseUrl).metadata.unknown,
    source.root.boundingBox,
  );
  let parent = source.root.child.north;
  for (let depth = 2; depth <= 1500; depth++) {
    const child = node(`deep-${depth}`);
    parent.childNum = 1;
    parent.child = { next: child };
    parent = child;
  }
  assert.throws(() => parseLcc2Manifest(source, baseUrl), /maxDepth/);
  const result = parseLcc2Manifest(source, baseUrl, {
    maxDepth: 1500,
    maxNodes: 1503,
  });
  assert.equal(result.nodes.length, 1503);
  assert.equal(result.nodes.at(-1).depth, 1500);
});

test("LCC2 bytes parser honors view offsets, rejects malformed UTF-8/JSON and checks raw bytes first", () => {
  const json = JSON.stringify(fixture());
  const encoded = new TextEncoder().encode(`!${json}!`);
  const view = encoded.subarray(1, -1);
  assert.equal(parseLcc2Bytes(view, baseUrl).nodes.length, 4);
  assert.equal(
    parseLcc2Bytes(new DataView(view.buffer, 1, view.byteLength), baseUrl).nodes
      .length,
    4,
  );
  assert.equal(parseLcc2Bytes(view.slice().buffer, baseUrl).nodes.length, 4);
  assert.throws(
    () => parseLcc2Bytes(view, baseUrl, { maxBytes: view.byteLength - 1 }),
    /maxBytes/,
  );
  assert.throws(
    () => parseLcc2Bytes(new Uint8Array([0xff]), baseUrl),
    /invalid UTF-8 JSON/,
  );
  assert.throws(
    () => parseLcc2Bytes(new TextEncoder().encode("{"), baseUrl),
    /invalid UTF-8 JSON/,
  );
  assert.throws(() => parseLcc2Bytes(json, baseUrl), /ArrayBuffer/);
  const whitespace = new TextEncoder().encode(`${json}${" ".repeat(100)}`);
  assert.throws(
    () => parseLcc2Bytes(whitespace, baseUrl, { maxBytes: view.byteLength }),
    /maxBytes/,
  );
});
