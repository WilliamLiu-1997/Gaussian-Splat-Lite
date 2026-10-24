import assert from "node:assert/strict";
import test from "node:test";
import {
  Box3,
  Frustum,
  LoadingManager,
  Matrix4,
  OrthographicCamera,
  Vector3,
} from "three";
import { RadSource } from "../src/loaders/rad/RadSource.js";
import { readLccScene } from "../src/loaders/stream/lcc-stream/lccScene.js";

const url = "https://lcc.invalid/scene/scene.lcc";

function sceneFiles() {
  const meta = {
    version: "5.0",
    encoding: "COMPRESS",
    fileType: "Portable",
    totalLevel: 2,
    indexDataSize: 36,
    totalSplats: 4,
    splats: [2, 2],
    cellLengthX: 5,
    cellLengthY: 5,
    boundingBox: { min: [0, 0, 0], max: [20, 20, 10] },
    attributes: [
      { name: "scale", min: [0, 0, 0], max: [1, 1, 1] },
      { name: "envscale", min: [0, 0, 0], max: [1, 1, 1] },
    ],
  };
  const index = new Uint8Array(72);
  const view = new DataView(index.buffer);
  for (const [unit, id] of [65537, 0].entries()) {
    view.setUint32(unit * 36, id, true);
    for (let level = 0; level < 2; level++) {
      const at = unit * 36 + 4 + level * 16;
      view.setUint32(at, 1, true);
      view.setBigUint64(at + 4, BigInt((unit * 2 + level) * 32), true);
      view.setUint32(at + 12, 32, true);
    }
  }
  const data = new Uint8Array(128);
  const records = new DataView(data.buffer);
  // Synthetic coarse and fine records cross their Unit's nominal X cell edge.
  for (const offset of [0, 32])
    [10.25, 7.5, 5].forEach((value, axis) =>
      records.setFloat32(offset + axis * 4, value, true),
    );
  return new Map([
    [url, new TextEncoder().encode(JSON.stringify(meta))],
    [new URL("index.bin", url).href, index],
    [new URL("data.bin", url).href, data],
  ]);
}

function serve(t, files, respond = () => undefined) {
  t.mock.method(globalThis, "fetch", async (path, options) => {
    const range = new Headers(options?.headers).get("Range");
    const override = respond(path, range);
    if (override) return override;
    const bytes = files.get(path);
    if (!bytes) return new Response(null, { status: 404 });
    if (!range) return new Response(bytes);
    assert.equal(range, "bytes=0-0");
    return new Response(bytes.subarray(0, 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-0/${bytes.length}`,
        ETag: '"original"',
      },
    });
  });
}

const read = (options = {}) =>
  readLccScene({ url, ...options }, new AbortController().signal);

test("LCC scene bounds retain records outside nominal Unit cells in a narrow frustum", async (t) => {
  serve(t, sceneFiles());
  const model = await read();
  const unit = model.units.find((candidate) => candidate.id === "65537");
  const center = new Vector3(10.25, 7.5, 5);
  const camera = new OrthographicCamera(-0.01, 0.01, 0.01, -0.01, 0.1, 10);
  camera.position.copy(center).add(new Vector3(0, 0, 3));
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    ),
  );
  assert.ok(frustum.containsPoint(center));
  assert.equal(
    frustum.intersectsBox(
      new Box3(new Vector3(5, 5, 0), new Vector3(10, 10, 10)),
    ),
    false,
  );
  assert.ok(
    frustum.intersectsBox(
      new Box3(
        new Vector3(...unit.boundingBox.min),
        new Vector3(...unit.boundingBox.max),
      ),
    ),
    "A visible record must not be culled by its nominal cell",
  );
});

test("LCC optional remote environment accepts only an exact empty 416 total", async (t) => {
  for (const name of ["environment.bin", "Environment.bin"]) {
    await t.test(`${name} is present but empty`, async (t) => {
      let cancelled = false;
      let requests = 0;
      const manager = new LoadingManager();
      const errors = [];
      manager.onError = (path) => errors.push(path);
      serve(t, sceneFiles(), (path, range) => {
        if (!path.endsWith(name)) return undefined;
        requests++;
        assert.equal(range, "bytes=0-0");
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 416,
            headers: { "Content-Range": "bytes */0", ETag: '"empty"' },
          },
        );
      });
      const model = await read({ manager });
      assert.equal(model.environment, undefined);
      assert.equal(model.coarseCount, 2);
      assert.equal(requests, 1);
      assert.equal(cancelled, true);
      assert.deepEqual(errors, []);
    });
  }
  for (const contentRange of [
    null,
    "bytes */32",
    "bytes */00",
    "bytes 0-0/0",
    "bytes */9007199254740992",
  ]) {
    await t.test(`rejects 416 with ${contentRange}`, async (t) => {
      serve(t, sceneFiles(), (path) =>
        path.endsWith("environment.bin")
          ? new Response(null, {
              status: 416,
              headers:
                contentRange === null ? {} : { "Content-Range": contentRange },
            })
          : undefined,
      );
      await assert.rejects(read(), /HTTP 416/);
    });
  }
  await t.test(
    "required data is not an optional empty environment",
    async (t) => {
      serve(t, sceneFiles(), (path) =>
        path.endsWith("data.bin")
          ? new Response(null, {
              status: 416,
              headers: { "Content-Range": "bytes */0" },
            })
          : undefined,
      );
      await assert.rejects(read(), /HTTP 416/);
    },
  );
});

test("LCC environment probes retain validators for subsequent transport reads", async (t) => {
  for (const headers of [
    { ETag: '"original"' },
    { ETag: 'W/"weak"', "Last-Modified": "Wed, 21 Oct 2026 10:00:00 GMT" },
  ]) {
    await t.test(JSON.stringify(headers), async (t) => {
      const files = sceneFiles();
      const environmentUrl = new URL("environment.bin", url).href;
      files.set(environmentUrl, new Uint8Array(32));
      serve(t, files, (path, range) => {
        if (path !== environmentUrl) return undefined;
        return new Response(new Uint8Array(range === "bytes=0-0" ? 1 : 32), {
          status: 206,
          headers: {
            "Content-Range":
              range === "bytes=0-0" ? "bytes 0-0/32" : "bytes 0-31/32",
            ...(range === "bytes=0-0"
              ? headers
              : {
                  ETag: '"changed"',
                  "Last-Modified": "Thu, 22 Oct 2026 10:00:00 GMT",
                }),
          },
        });
      });
      const source = (await read()).environment.ranges[0].source;
      await assert.rejects(
        RadSource.readPreparedChunk(
          {
            input: source.url,
            offset: source.offset,
            length: source.byteLength,
            state: source.resourceState,
          },
          new AbortController().signal,
        ),
        /resource version changed/,
      );
    });
  }
});
