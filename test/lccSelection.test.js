import assert from "node:assert/strict";
import test from "node:test";
import { LoadingManager } from "three";
import { LccStreamScheduler } from "../src/loaders/stream/lcc-stream/LccStreamScheduler.js";
import {
  readLccScene,
  selectLccUnits,
} from "../src/loaders/stream/lcc-stream/lccScene.js";

const unit = {
  id: "u",
  representations: [
    { id: "coarse", level: 2, count: 2 },
    { id: "medium", level: 1, count: 4 },
    { id: "fine", level: 0, count: 8 },
  ],
};
function select(distance, current, options = {}, budget = 100) {
  return selectLccUnits(
    [unit],
    budget,
    new Map([[unit.id, distance]]),
    new Map(
      current ? [[unit.id, { rep: unit.representations[current - 1] }]] : [],
    ),
    options,
  ).get(unit.id)?.id;
}

test("LCC keeps coarse-first selection and budget-only defaults", () => {
  assert.equal(select(0), "coarse");
  assert.equal(select(1e9, 1), "fine");
  assert.equal(select(0, 3, {}, 4), "medium");
  assert.equal(select(0, 3, {}, 1), undefined);
  const other = {
    ...unit,
    id: "v",
    representations: unit.representations.map((rep) => ({
      ...rep,
      id: `v-${rep.id}`,
    })),
  };
  const units = [other, unit];
  const scores = new Map([
    ["u", 1],
    ["v", 100],
  ]);
  assert.deepEqual(
    [...selectLccUnits(units, 10, scores).values()].map((rep) => rep.id),
    ["coarse", "v-coarse"],
  );
  const selected = selectLccUnits(
    units,
    10,
    scores,
    new Map([
      ["u", {}],
      ["v", {}],
    ]),
  );
  assert.deepEqual(
    [...selected.values()].map((rep) => rep.id),
    ["fine", "v-coarse"],
  );
  assert.equal(
    [...selected.values()].reduce((sum, rep) => sum + rep.count, 0),
    10,
  );
  assert.equal(selectLccUnits([unit], 100, new Map()).size, 0);
});

test("LCC distance bands include exact low/high boundaries without hysteresis", () => {
  const options = { lodDistances: [100, 20], lodHysteresis: 0 };
  for (const [distance, expected] of [
    [101, "coarse"],
    [100, "medium"],
    [99, "medium"],
    [21, "medium"],
    [20, "fine"],
    [19, "fine"],
    [0, "fine"],
  ])
    assert.equal(
      select(distance, 1, options),
      expected,
      `distance ${distance}`,
    );
  assert.equal(select(0, 1, { lodDistances: [] }), "coarse");
  assert.equal(select(0, 1, { lodDistances: [100] }), "medium");
  assert.equal(select(0, undefined, options), "coarse");
});

test("LCC hysteresis enters and exits each distance band independently", () => {
  const options = { lodDistances: [100, 20], lodHysteresis: 0.25 };
  assert.equal(select(76, 1, options), "coarse");
  assert.equal(select(75, 1, options), "medium");
  assert.equal(select(125, 2, options), "medium");
  assert.equal(select(126, 2, options), "coarse");
  assert.equal(select(16, 2, options), "medium");
  assert.equal(select(15, 2, options), "fine");
  assert.equal(select(25, 3, options), "fine");
  assert.equal(select(26, 3, options), "medium");
  assert.equal(select(86, 1, { lodDistances: [100] }), "coarse");
  assert.equal(select(85, 1, { lodDistances: [100] }), "medium");
});

test("LCC validates distance and hysteresis options", () => {
  for (const lodDistances of [
    null,
    3,
    [10, 20],
    [-1],
    [Number.NaN],
    ["10"],
    Array(1),
  ])
    assert.throws(() => select(0, 1, { lodDistances }), /lodDistances/);
  for (const lodHysteresis of [
    -0.1,
    1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "0",
    null,
  ])
    assert.throws(() => select(0, 1, { lodHysteresis }), /lodHysteresis/);
});

const url = "https://lcc.invalid/scene/scene.lcc";
function sceneFiles({
  lowercase = false,
  fileType = "Portable",
  missingType = false,
  environment = false,
} = {}) {
  const meta = {
    version: "5.0",
    encoding: "COMPRESS",
    fileType: missingType ? undefined : fileType,
    totalLevel: 2,
    indexDataSize: 36,
    totalSplats: 6,
    splats: [4, 2],
    cellLengthX: 10,
    cellLengthY: 10,
    offset: [0, 0, 0],
    shift: [0, 0, 0],
    scale: [1, 1, 1],
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    attributes: [
      { name: "scale", min: [0, 0, 0], max: [1, 1, 1] },
      { name: "shcoef", min: [-1, -1, -1], max: [1, 1, 1] },
      { name: "envscale", min: [0, 0, 0], max: [1, 1, 1] },
      { name: "envshcoef", min: [-1, -1, -1], max: [1, 1, 1] },
    ],
  };
  const index = new Uint8Array(36);
  const view = new DataView(index.buffer);
  for (const [level, count, offset] of [
    [0, 4, 0n],
    [1, 2, 128n],
  ]) {
    const at = 4 + level * 16;
    view.setUint32(at, count, true);
    view.setBigUint64(at + 4, offset, true);
    view.setUint32(at + 12, count * 32, true);
  }
  const files = new Map([
    [url, new TextEncoder().encode(JSON.stringify(meta))],
    [new URL("Index.bin", url).href, index],
    [new URL("Data.bin", url).href, new Uint8Array(192)],
  ]);
  if (fileType === "Quality")
    files.set(new URL("Shcoef.bin", url).href, new Uint8Array(384));
  if (environment)
    files.set(
      new URL("Environment.bin", url).href,
      new Uint8Array(fileType === "Quality" ? 96 : 32),
    );
  if (lowercase)
    for (const [path, bytes] of [...files]) {
      if (!path.endsWith(".bin")) continue;
      files.delete(path);
      files.set(path.toLowerCase(), bytes);
    }
  return files;
}
function mockFiles(t, files, { local = false, response } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    const range = new Headers(options?.headers).get("Range");
    requests.push({ path, range });
    if (response) {
      const result = response(path, range);
      if (result) return result;
    }
    const bytes = files.get(path);
    if (!bytes) return new Response(null, { status: 404 });
    if (range) {
      assert.equal(range, "bytes=0-0");
      return new Response(bytes.subarray(0, 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-0/${bytes.length}`,
          "Content-Length": "1",
          ETag: '"fixture-v1"',
        },
      });
    }
    return new Response(bytes);
  });
  const manager = new LoadingManager();
  if (local)
    manager.getFileSize = (path) => files.get(path)?.byteLength ?? null;
  return { manager, requests };
}
const read = (options) =>
  readLccScene({ url, ...options }, new AbortController().signal);

test("LCC accepts empty remote indices without payload probes", async (t) => {
  const files = sceneFiles();
  const meta = JSON.parse(new TextDecoder().decode(files.get(url)));
  meta.totalSplats = 0;
  meta.splats = [0, 0];
  files.set(url, new TextEncoder().encode(JSON.stringify(meta)));
  files.set(new URL("Index.bin", url).href, new Uint8Array());
  const { requests } = mockFiles(t, files);
  const model = await read();
  assert.deepEqual(model.units, []);
  assert.equal(model.coarseCount, 0);
  assert.ok(
    requests.every(({ path }) => !/[Dd]ata.bin$|[Ss]hcoef.bin$/.test(path)),
  );
});

test("LCC environment probe needs a validated total and never downloads the whole file", async (t) => {
  const { requests } = mockFiles(t, sceneFiles({ environment: true }), {
    response: (path, range) =>
      path.endsWith("Environment.bin") && range
        ? new Response(new Uint8Array(1), { status: 206 })
        : undefined,
  });
  await assert.rejects(read(), /exposed Content-Range total/);
  assert.ok(
    requests
      .filter(({ path }) => path.endsWith("Environment.bin"))
      .every(({ range }) => range === "bytes=0-0"),
  );
});

test("LCC resolves exact documented and lowercase local companions without probes", async (t) => {
  for (const lowercase of [false, true]) {
    const files = sceneFiles({
      lowercase,
      fileType: "Quality",
      environment: true,
    });
    const { manager, requests } = mockFiles(t, files, { local: true });
    const model = await read({ manager, maxResidentCpuBytes: 1024 * 1024 });
    const rep = model.units[0].representations[0];
    assert.equal(
      rep.ranges[0].source.url,
      new URL(lowercase ? "data.bin" : "Data.bin", url).href,
    );
    assert.equal(
      rep.ranges[0].source.shUrl,
      new URL(lowercase ? "shcoef.bin" : "Shcoef.bin", url).href,
    );
    assert.equal(rep.ranges[0].node.index, 0);
    assert.equal(model.environment.count, 1);
    assert.equal(model.coarseCount, 2);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.range === null));
  }
});

test("LCC remote companion probes validate one byte and fall back on HTTP 404 only", async (t) => {
  for (const lowercase of [false, true]) {
    const { requests } = mockFiles(
      t,
      sceneFiles({ lowercase, fileType: "Quality", environment: true }),
    );
    const model = await read({ maxResidentCpuBytes: 1024 * 1024 });
    assert.equal(model.environment.count, 1);
    const source = model.units[0].representations[0].ranges[0].source;
    assert.equal(source.resourceState.validator, '"fixture-v1"');
    assert.equal(source.resourceState.total, 192);
    assert.equal(source.shResourceState.total, 384);
    assert.equal(model.environment.ranges[0].source.resourceState.total, 96);
    assert.equal(
      model.units[0].representations[0].ranges[0].source.shByteLength,
      128,
    );
    assert.ok(
      requests
        .filter(({ path }) => !/scene\.lcc$|[Ii]ndex\.bin$/.test(path))
        .every(({ range }) => range === "bytes=0-0"),
    );
  }
  for (const status of [403, 500]) {
    const { requests } = mockFiles(t, sceneFiles(), {
      response: (path, range) =>
        range && path.endsWith("/data.bin")
          ? new Response(null, { status })
          : undefined,
    });
    await assert.rejects(read(), new RegExp(`HTTP ${status}`));
    assert.equal(
      requests.some(({ path }) => path.endsWith("/Data.bin")),
      false,
    );
  }
});

test("LCC public scheduler passes missing fileType override under finite CPU budgets", async (t) => {
  for (const fileType of ["Portable", "Quality"]) {
    const { manager } = mockFiles(
      t,
      sceneFiles({ fileType, missingType: true }),
      { local: true },
    );
    await assert.rejects(read({ manager }), /fileType must explicitly/);
    const scheduler = new LccStreamScheduler({
      url,
      manager,
      fileType,
      maxResidentCpuBytes: 128 * 1024 * 1024,
    });
    try {
      await scheduler.initialized;
      assert.equal(
        scheduler.model.units[0].representations[0].ranges[0].source.context
          .fileType,
        fileType,
      );
    } finally {
      scheduler.dispose();
    }
  }
});

test("LCC optional environment accepts only known absence or HTTP 404", async (t) => {
  for (const local of [false, true]) {
    const { manager } = mockFiles(t, sceneFiles(), { local });
    assert.equal((await read({ manager })).environment, undefined);
  }
  for (const status of [403, 500]) {
    mockFiles(t, sceneFiles(), {
      response: (path) =>
        path.endsWith("Environment.bin")
          ? new Response(null, { status })
          : undefined,
    });
    await assert.rejects(read(), new RegExp(`HTTP ${status}`));
  }
});

test("LCC missing Quality SH fails while Portable needs no SH file", async (t) => {
  const files = sceneFiles({ fileType: "Quality" });
  files.delete(new URL("Shcoef.bin", url).href);
  const { manager } = mockFiles(t, files, { local: true });
  await assert.rejects(read({ manager }), /missing Shcoef.bin/);
  mockFiles(t, sceneFiles());
  assert.equal((await read()).environment, undefined);
});

test("LCC propagates ambiguous local resolver errors and accepts exact path overrides", async (t) => {
  const files = sceneFiles();
  const { manager } = mockFiles(t, files, { local: true });
  const data = new URL("Data.bin", url).href;
  files.set(new URL("data.bin", url).href, files.get(data));
  await assert.rejects(read({ manager }), /ambiguous data companions/);
  await read({ manager, companionPaths: { data: "Data.bin" } });
  files.set(new URL("payload.dat", url).href, files.get(data));
  const model = await read({
    manager,
    companionPaths: { data: "payload.dat" },
  });
  assert.equal(
    model.units[0].representations[0].ranges[0].source.url,
    new URL("payload.dat", url).href,
  );
  const failure = new Error("Ambiguous local environment resolver");
  manager.getFileSize = undefined;
  manager.setURLModifier((path) => {
    if (path.endsWith("Environment.bin")) throw failure;
    return path;
  });
  await assert.rejects(read({ manager }), (error) => error === failure);
});

test("LCC probes reject ignored/mismatched Range and malformed environment sizes", async (t) => {
  for (const response of [
    () => new Response(new Uint8Array(1024)),
    () =>
      new Response(new Uint8Array(1), {
        status: 206,
        headers: { "Content-Range": "bytes 1-1/192" },
      }),
  ]) {
    mockFiles(t, sceneFiles(), {
      response: (path, range) =>
        range && path.endsWith("Data.bin") ? response() : undefined,
    });
    await assert.rejects(read(), /ignored Range|Content-Range does not match/);
  }
  const files = sceneFiles({ environment: true });
  files.set(new URL("Environment.bin", url).href, new Uint8Array(33));
  const { manager } = mockFiles(t, files, { local: true });
  await assert.rejects(
    read({ manager }),
    /environment has an invalid byte length/,
  );
});
