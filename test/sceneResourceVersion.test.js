import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import init from "gaussian-splat-rs";
import { SceneStreamLoader } from "../src/loaders/stream/scene-stream/SceneStreamLoader.js";
import { createSceneStreamHandlers } from "../src/loaders/stream/scene-stream/workerHandlers.js";

test("new LCC workers retain the manifest probe's resource validator", async (context) => {
  await init({
    module_or_path: await readFile(
      new URL(
        "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
        import.meta.url,
      ),
    ),
  });
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(new Uint8Array(32), {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-31/32",
          "Content-Length": "32",
          ETag: '"changed"',
        },
      }),
  );
  let decoded = 0;
  const handlers = createSceneStreamHandlers(
    () => {},
    () => {
      decoded++;
      throw new Error("Unexpected decode");
    },
  );
  const url = "https://scene.invalid/data.bin";
  await assert.rejects(
    handlers.loadSceneSource(
      {
        id: 1,
        url,
        source: {
          codec: "lcc",
          url,
          count: 1,
          shDegree: 0,
          offset: 0,
          byteLength: 32,
          inputBytes: 32,
          context: { count: 1 },
          resourceState: {
            total: 32,
            validator: '"original"',
            validatorHeader: "ETag",
          },
        },
      },
      { sendStatus() {} },
    ),
    /resource version changed/,
  );
  assert.equal(decoded, 0);
});

// Keep real WorkerRpc ordering without the bundler-only WASM asset import.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith("/src/runtime/wasm.js"))
        return {
          format: "module",
          source: "export const WASM_MODULE = Promise.resolve(null);",
          shortCircuit: true,
        };
      return nextLoad(url, context);
    }
  `)}`,
);
const { WorkerRpc } = await import("../src/runtime/WorkerRpc.js");

const ply = new TextEncoder().encode(
  "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n",
);
const spz = new Uint8Array(32);
new DataView(spz.buffer).setUint32(0, 0x5053474e, true);
new DataView(spz.buffer).setUint32(4, 4, true);
new DataView(spz.buffer).setUint32(8, 1, true);
const sog = new TextEncoder().encode('{"version":2,"count":1}');

function sessionLoader(decode) {
  let workers = 0;
  class Transport {
    handlers = createSceneStreamHandlers(decode, () => {});
    emit(data) {
      queueMicrotask(() =>
        this.onmessage({ data: { wasmMemoryBytes: 0, ...data } }),
      );
    }
    postMessage({ id, name, args }) {
      if (name === "init-wasm") return;
      Promise.resolve()
        .then(() =>
          this.handlers[name](args, {
            sendStatus: (status) => this.emit({ id, status }),
          }),
        )
        .then(
          (result) => this.emit({ id, result }),
          (error) => this.emit({ id, error }),
        );
    }
    terminate() {}
  }
  class DirectWorker extends WorkerRpc {
    constructor(onDispose) {
      super(new Transport(), onDispose);
      workers++;
    }
  }
  const loader = new SceneStreamLoader(
    {
      url: "https://scene.invalid/scene.lcc2",
      requestHeader: { Authorization: "Bearer secret" },
      withCredentials: true,
      manager: {
        resolveURL: () => `blob:https://local.invalid/copy-${workers}`,
        itemStart() {},
        itemEnd() {},
        itemError() {},
      },
    },
    () => {},
  );
  loader.workerModule = Promise.resolve({ SceneStreamWorker: DirectWorker });
  return { loader, workers: () => workers };
}

const decodedSource = () => ({
  numSplats: 1,
  splatArrays: [new Uint32Array(4), new Uint32Array(4)],
  sortCenters: new Float32Array(3),
  extra: {},
});

for (const [codec, body] of [
  ["ply", ply],
  ["spz", spz],
  ["sog", sog],
]) {
  for (const change of [
    "ETag",
    "Last-Modified",
    "length",
    "hidden-validator",
  ]) {
    test(`${codec} reload rejects ${change} changes across worker replacement`, async (context) => {
      let requests = 0;
      let decodes = 0;
      context.mock.method(globalThis, "fetch", async (_url, options) => {
        assert.equal(options.headers.get("Authorization"), null);
        assert.equal(options.credentials, "same-origin");
        requests++;
        const bytes =
          change === "length" && requests > 1
            ? new Uint8Array([...body, 32])
            : body;
        const headers = { "Content-Length": String(bytes.length) };
        if (change === "ETag") headers.ETag = `"v${requests}"`;
        if (change === "Last-Modified")
          headers["Last-Modified"] =
            requests === 1
              ? "Wed, 21 Oct 2015 07:28:00 GMT"
              : "Wed, 21 Oct 2015 07:29:00 GMT";
        if (change === "hidden-validator" && requests === 1)
          headers.ETag = '"v1"';
        return new Response(bytes, { headers });
      });
      const { loader, workers } = sessionLoader(() => {
        decodes++;
        return decodedSource();
      });
      const source = {
        codec,
        url: `https://scene.invalid/shared.${codec}`,
        count: 1,
        shDegree: 0,
      };
      try {
        const first = await loader.load(source, new AbortController().signal);
        await first.dispose();
        await assert.rejects(
          loader.load(
            { ...source, key: "another-range" },
            new AbortController().signal,
          ),
          change === "length"
            ? /resource length changed/
            : /resource version changed/,
        );
        assert.equal(workers(), 2);
        assert.equal(
          decodes,
          1,
          "changed resource must not reach decode/publication",
        );
      } finally {
        loader.dispose();
      }
    });
  }
}

for (const mode of ["hidden", "gzip", "cors-gzip"]) {
  test(`reload accepts stable resources with ${mode} headers`, async (context) => {
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requests++;
      const headers =
        mode === "hidden"
          ? {}
          : {
              ETag: '"stable"',
              "Content-Length": String(requests === 1 ? 21 : 22),
              ...(mode === "gzip" ? { "Content-Encoding": "gzip" } : {}),
            };
      const response = new Response(ply, { headers });
      if (mode === "cors-gzip")
        Object.defineProperty(response, "type", { value: "cors" });
      return response;
    });
    const { loader } = sessionLoader(decodedSource);
    try {
      for (let index = 0; index < 2; index++) {
        const handle = await loader.load(
          {
            codec: "ply",
            url: "https://scene.invalid/shared.ply",
            count: 1,
            shDegree: 0,
          },
          new AbortController().signal,
        );
        await handle.dispose();
      }
      assert.equal(requests, 2);
    } finally {
      loader.dispose();
    }
  });
}
