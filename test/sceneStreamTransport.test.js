import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import init from "gaussian-splat-rs";
import { SceneStreamLoader } from "../src/loaders/stream/scene-stream/SceneStreamLoader.js";
import { createSceneStreamHandlers } from "../src/loaders/stream/scene-stream/workerHandlers.js";
import { abortable } from "../src/runtime/abort.js";

test("LCC companions scope credentials to the original scene origin", async (context) => {
  await init({
    module_or_path: await readFile(
      new URL(
        "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
        import.meta.url,
      ),
    ),
  });
  const scene = "https://scene.invalid";
  const other = "https://other.invalid";
  for (const [name, baseOrigin, shOrigin, resolvedShOrigin] of [
    ["same-origin companions", scene, scene, scene],
    ["cross-origin SH", scene, other, other],
    ["same-origin SH with cross-origin base", other, scene, scene],
    ["SH remapped cross-origin", scene, scene, other],
  ]) {
    await context.test(name, async (context) => {
      const requests = [];
      context.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({
          url,
          authorization: options.headers.get("Authorization"),
          credentials: options.credentials,
        });
        const size = url.endsWith("sh.bin") ? 64 : 32;
        return new Response(new Uint8Array(size), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${size - 1}/${size}` },
        });
      });
      const handlers = createSceneStreamHandlers(
        () => {
          throw new Error("Unexpected ordinary decoder");
        },
        () => ({
          numSplats: 1,
          splat0: new Uint32Array(4),
          splat1: new Uint32Array(4),
        }),
      );
      class DirectWorker {
        disposed = false;
        peakWasmMemoryBytes = 0;
        async call(name, args, options) {
          return handlers[name](args, {
            sendStatus: (status) => options?.onStatus?.(status),
          });
        }
        dispose() {
          this.disposed = true;
        }
      }
      const loader = new SceneStreamLoader(
        {
          url: `${scene}/scene.lcc`,
          requestHeader: { Authorization: "Bearer scene-secret" },
          withCredentials: true,
          manager: {
            resolveURL(url) {
              return url.endsWith("sh.bin")
                ? `${resolvedShOrigin}/sh.bin`
                : url;
            },
            itemStart() {},
            itemEnd() {},
            itemError() {},
          },
        },
        () => {},
      );
      loader.workerModule = Promise.resolve({
        SceneStreamWorker: DirectWorker,
      });
      let handle;
      try {
        handle = await loader.load(
          {
            codec: "lcc",
            url: `${baseOrigin}/base.bin`,
            shUrl: `${shOrigin}/sh.bin`,
            count: 1,
            shDegree: 3,
            offset: 0,
            byteLength: 32,
            shOffset: 0,
            shByteLength: 64,
            inputBytes: 96,
            context: { count: 1 },
          },
          new AbortController().signal,
        );
        assert.deepEqual(requests, [
          {
            url: `${baseOrigin}/base.bin`,
            authorization: baseOrigin === scene ? "Bearer scene-secret" : null,
            credentials: baseOrigin === scene ? "include" : "same-origin",
          },
          {
            url: `${resolvedShOrigin}/sh.bin`,
            authorization:
              shOrigin === scene && resolvedShOrigin === scene
                ? "Bearer scene-secret"
                : null,
            credentials:
              shOrigin === scene && resolvedShOrigin === scene
                ? "include"
                : "same-origin",
          },
        ]);
      } finally {
        await handle?.dispose();
        loader.dispose();
      }
    });
  }
});

// WorkerRpc's bundler-only WASM import is irrelevant to these transport tests.
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

for (const failure of ["missing", "cancel", "resolver"]) {
  test(`queued SOG sidecar ${failure} settles without evicting another cache`, async (context) => {
    const controller = new AbortController();
    const retained = new AbortController();
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      requests.push(url);
      if (url.endsWith("missing.webp")) {
        if (failure === "cancel") {
          controller.abort();
          throw controller.signal.reason;
        }
        return new Response("missing", { status: 404 });
      }
      assert.ok(url.endsWith("hanging.webp"));
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      });
    });
    class Transport {
      cached = new Set();
      emit(data) {
        queueMicrotask(() =>
          this.onmessage({ data: { wasmMemoryBytes: 0, ...data } }),
        );
      }
      postMessage({ id, name, args }) {
        if (name === "init-wasm") return;
        if (name === "loadSceneSource") {
          if (args.source.codec !== "sog") {
            this.cached.add(args.id);
            this.emit({
              id,
              result: { numSplats: 1, numSh: 0, byteLength: 32 },
            });
            return;
          }
          this.loadId = id;
          this.emit({ id, status: { loaded: 1 } });
          this.emit({
            id,
            status: { fileRequest: 1, filename: "missing.webp" },
          });
          this.emit({
            id,
            status: { fileRequest: 2, filename: "hanging.webp" },
          });
        } else if (name === "releaseSceneSource") {
          this.cached.delete(args.id);
          if (this.loadId !== undefined) {
            this.emit({
              id: this.loadId,
              error: new DOMException("Source canceled", "AbortError"),
            });
            this.loadId = undefined;
          }
          this.emit({ id, result: undefined });
        } else if (name === "extractSceneRanges") {
          if (this.cached.has(args.id)) this.emit({ id, result: args.ranges });
          else this.emit({ id, error: new Error("Source no longer cached") });
        } else {
          throw new Error(`Unexpected RPC ${name}`);
        }
      }
      terminate() {
        this.cached.clear();
      }
    }
    class TestWorker extends WorkerRpc {
      constructor(onDispose) {
        super(new Transport(), onDispose);
      }
    }
    const loader = new SceneStreamLoader(
      {
        url: "https://scene.invalid/scene.lcc2",
        manager:
          failure === "resolver"
            ? {
                resolveURL(url) {
                  if (url.endsWith("missing.webp"))
                    throw new Error("Missing companion");
                  return url;
                },
                itemStart() {},
                itemEnd() {},
                itemError() {},
              }
            : undefined,
      },
      () => {},
    );
    loader.workerModule = Promise.resolve({ SceneStreamWorker: TestWorker });
    const first = await loader.load(
      { codec: "ply", url: "https://scene.invalid/first.ply" },
      retained.signal,
    );
    const pending = loader.load(
      { codec: "sog", url: "https://scene.invalid/meta.json" },
      controller.signal,
    );
    let timeout;
    try {
      await Promise.race([
        assert.rejects(
          pending,
          failure === "cancel"
            ? { name: "AbortError" }
            : failure === "resolver"
              ? /Missing companion/
              : /HTTP 404/,
        ),
        new Promise((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Sidecar failure did not settle the load")),
            1000,
          );
        }),
      ]);
      assert.equal(retained.signal.aborted, false);
      assert.equal(controller.signal.aborted, failure === "cancel");
      assert.deepEqual(
        requests,
        failure === "resolver" ? [] : ["https://scene.invalid/missing.webp"],
      );
      assert.deepEqual(await first.extract([{ start: 0, count: 1 }]), [
        { start: 0, count: 1 },
      ]);
      const next = await loader.load(
        { codec: "ply", url: "https://scene.invalid/next.ply" },
        retained.signal,
      );
      await next.dispose();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await pending.catch(() => {});
      await first.dispose();
      loader.dispose();
    }
  });
}

function transportWorker(decode) {
  class Transport {
    files = new Map();
    nextFile = 0;
    handlers = createSceneStreamHandlers(
      async (args, rpc) => {
        const readFile = async (filename) => {
          const requestId = ++this.nextFile;
          try {
            return await abortable(
              new Promise((resolve) => {
                this.files.set(requestId, resolve);
                rpc.sendStatus({ fileRequest: requestId, filename });
              }),
              args.signal,
            );
          } finally {
            this.files.delete(requestId);
          }
        };
        await decode(args, rpc, readFile);
        return {
          numSplats: 1,
          splatArrays: [new Uint32Array(4), new Uint32Array(4)],
          sortCenters: new Float32Array(3),
          extra: {},
        };
      },
      () => {},
    );
    emit(data) {
      queueMicrotask(() =>
        this.onmessage({ data: { wasmMemoryBytes: 0, ...data } }),
      );
    }
    postMessage({ id, name, args }) {
      if (name === "init-wasm") return;
      Promise.resolve()
        .then(() => {
          if (name === "resolveFile")
            return this.files.get(args.requestId)?.(args.input);
          return this.handlers[name](args, {
            sendStatus: (status) => this.emit({ id, status }),
          });
        })
        .then(
          (result) => this.emit({ id, result }),
          (error) => this.emit({ id, error }),
        );
    }
    terminate() {}
  }
  return class extends WorkerRpc {
    constructor(onDispose) {
      super(new Transport(), onDispose);
    }
  };
}

for (const overflow of [false, true]) {
  test(`SOG RPC counts root and sidecars once and ${overflow ? "rejects over" : "accepts exact"} input limit`, async (context) => {
    const root = new TextEncoder().encode('{"version":2,"count":1}');
    const sidecars = new Map([
      ["https://scene.invalid/a.webp", new Uint8Array(3)],
      ["https://other.invalid/b.webp", new Uint8Array(5)],
      ["https://scene.invalid/c.webp", new Uint8Array(7)],
    ]);
    const total = root.length + 3 + 5 + 7;
    const requests = [];
    const events = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      requests.push(url);
      assert.equal(
        options.headers.get("Authorization"),
        url.startsWith("https://scene.invalid/") ? "Bearer secret" : null,
      );
      assert.equal(
        options.credentials,
        url.startsWith("https://scene.invalid/") ? "include" : "same-origin",
      );
      return new Response(url.endsWith("meta.json") ? root : sidecars.get(url));
    });
    let completed = false;
    const loader = new SceneStreamLoader(
      {
        url: "https://scene.invalid/scene.lcc2",
        requestHeader: { Authorization: "Bearer secret" },
        withCredentials: true,
        manager: {
          resolveURL: (url) =>
            url.replace(
              "https://scene.invalid/b.webp",
              "https://other.invalid/b.webp",
            ),
          itemStart: (url) => events.push(["start", url]),
          itemEnd: (url) => events.push(["end", url]),
          itemError: (url) => events.push(["error", url]),
        },
      },
      () => {},
    );
    loader.workerModule = Promise.resolve({
      SceneStreamWorker: transportWorker(async (args, rpc, readFile) => {
        for (const filename of ["a.webp", "b.webp", "c.webp"]) {
          rpc.sendStatus({ loaded: root.length });
          await readFile(filename);
          rpc.sendStatus({ loaded: root.length });
          rpc.sendStatus({ stage: "decode", loaded: 1, total: 1 });
        }
        completed = true;
      }),
    });
    let handle;
    try {
      const pending = loader.load(
        {
          codec: "sog",
          url: "https://scene.invalid/meta.json",
          count: 1,
          shDegree: 0,
          maxInputBytes: total - Number(overflow),
        },
        new AbortController().signal,
      );
      if (overflow) await assert.rejects(pending, /byte limit/);
      else handle = await pending;
      assert.equal(completed, !overflow);
      assert.deepEqual(requests, [
        "https://scene.invalid/meta.json",
        ...sidecars.keys(),
      ]);
      if (!overflow) assert.equal(loader.stats.downloadedBytes, total);
      for (const url of requests) {
        assert.equal(
          events.filter(([event, value]) => event === "start" && value === url)
            .length,
          1,
        );
        assert.equal(
          events.filter(([event, value]) => event === "end" && value === url)
            .length,
          1,
        );
      }
      assert.equal(
        events.filter(([event]) => event === "error").length,
        overflow ? 2 : 0,
      );
    } finally {
      await handle?.dispose();
      loader.dispose();
    }
  });
}

test("SOG sidecar validator survives source and worker eviction before file delivery", async (context) => {
  const root = new TextEncoder().encode('{"version":2,"count":1}');
  let sidecars = 0;
  let completed = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("meta.json")) return new Response(root);
    return new Response(new Uint8Array(3), {
      headers: { ETag: `"v${++sidecars}"` },
    });
  });
  const loader = new SceneStreamLoader(
    { url: "https://scene.invalid/scene.lcc2" },
    () => {},
  );
  loader.workerModule = Promise.resolve({
    SceneStreamWorker: transportWorker(async (_args, _rpc, readFile) => {
      await readFile("shared.webp");
      completed++;
    }),
  });
  const source = {
    codec: "sog",
    url: "https://scene.invalid/meta.json",
    count: 1,
    shDegree: 0,
  };
  try {
    const first = await loader.load(source, new AbortController().signal);
    await first.dispose();
    assert.equal(loader.stats.downloadedBytes, root.byteLength + 3);
    await assert.rejects(
      loader.load(source, new AbortController().signal),
      /resource version changed/,
    );
    assert.equal(loader.stats.downloadedBytes, 2 * (root.byteLength + 3));
    assert.equal(completed, 1);
  } finally {
    loader.dispose();
  }
});
