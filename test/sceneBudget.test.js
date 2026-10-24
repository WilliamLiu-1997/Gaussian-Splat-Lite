import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { SceneStreamLoader } from "../src/loaders/stream/scene-stream/SceneStreamLoader.js";
import {
  SceneMemory,
  sourceLimits,
  sourceMemory,
} from "../src/loaders/stream/scene-stream/memory.js";
import {
  SceneBudgetError,
  SceneSources,
} from "../src/loaders/stream/scene-stream/resources.js";
import { createSceneStreamHandlers } from "../src/loaders/stream/scene-stream/workerHandlers.js";

const source = {
  key: "payload",
  codec: "ply",
  url: "https://scene.invalid/file.ply",
  count: 1,
  shDegree: 4,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("loader cancellation releases late cache data but pins shared WASM growth", async () => {
  let worker;
  let finishDecode;
  const pending = new Promise((resolve) => {
    finishDecode = resolve;
  });
  class FakeWorker {
    disposed = false;
    peakWasmMemoryBytes = 0;
    cached = new Set();
    constructor(onDispose) {
      worker = this;
      this.onDispose = onDispose;
    }
    async call(name, args) {
      if (name === "loadSceneSource") {
        if (args.source.key === "large") await pending;
        this.peakWasmMemoryBytes =
          args.source.key === "large" ? 64 * 1024 * 1024 : 2 * 1024 * 1024;
        this.cached.add(args.id);
        return { numSplats: 1, numSh: 0, byteLength: 44 };
      }
      if (name === "releaseSceneSource") {
        this.cached.delete(args.id);
        return;
      }
      if (name === "extractSceneRanges") {
        assert.ok(this.cached.has(args.id));
        this.peakWasmMemoryBytes = 80 * 1024 * 1024;
        return args.ranges;
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
    dispose() {
      this.disposed = true;
      this.onDispose();
    }
  }
  const loader = new SceneStreamLoader(
    { url: "https://scene.invalid/scene.lcc2" },
    () => {},
  );
  loader.workerModule = Promise.resolve({ SceneStreamWorker: FakeWorker });
  const memory = new SceneMemory(256 * 1024 * 1024, 0);
  const sources = new SceneSources(
    (owned, signal) => loader.load(owned, signal),
    memory,
    new AbortController().signal,
  );
  const first = sources.acquire(source);
  const handle = await first.promise;
  const large = sources.acquire({
    ...source,
    key: "large",
    maxWasmBytes: 128 * 1024 * 1024,
  });
  await tick();
  const duringDecode = memory.cpu;
  large.release();
  await tick();
  assert.equal(memory.cpu, duringDecode);
  finishDecode();
  await assert.rejects(large.promise, { name: "AbortError" });
  await tick();
  assert.equal(worker.disposed, false);
  assert.equal(worker.cached.size, 1);
  assert.equal(memory.cpu, 44 + 128 * 1024 * 1024);
  assert.deepEqual(await handle.extract([{ start: 0, count: 1 }]), [
    { start: 0, count: 1 },
  ]);
  assert.equal(loader.stats.wasmMemoryBytes, 80 * 1024 * 1024);
  assert.equal(memory.cpu, 44 + 128 * 1024 * 1024);
  first.release();
  await sources.dispose();
  await tick();
  assert.equal(memory.cpu, 0);
  assert.equal(loader.stats.wasmMemoryBytes, 0);
  assert.equal(loader.stats.peakWasmMemoryBytes, 80 * 1024 * 1024);
  loader.dispose();
});

test("failed larger decode pins shared WASM capacity until the retained worker is disposed", async () => {
  const worker = {};
  let finishWorker;
  const lifetime = new Promise((resolve) => {
    finishWorker = resolve;
  });
  const memory = new SceneMemory(256 * 1024 * 1024, 0);
  const sources = new SceneSources(
    async (owned) => {
      if (owned.key === "large") {
        owned.pinWasm(worker, 64 * 1024 * 1024, lifetime);
        throw new Error("Decode canceled after growing memory");
      }
      owned.pinWasm(worker, 2 * 1024 * 1024, lifetime);
      return {
        dispose() {
          finishWorker();
        },
      };
    },
    memory,
    new AbortController().signal,
  );
  const first = sources.acquire(source);
  await first.promise;
  const large = sources.acquire({
    ...source,
    key: "large",
    maxWasmBytes: 128 * 1024 * 1024,
  });
  await assert.rejects(large.promise, /Decode canceled/);
  large.release();
  await tick();
  assert.equal(
    memory.cpu,
    sourceMemory(source) -
      sourceLimits(source).maxWasmBytes +
      128 * 1024 * 1024,
  );
  first.release();
  await sources.dispose();
  await tick();
  assert.equal(memory.cpu, 0);
});

const ply = (count) =>
  new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\nproperty float x\nend_header\n`,
  );
const data = (count) => ({
  numSplats: count,
  splatArrays: [new Uint32Array(count * 4), new Uint32Array(count * 4)],
  sortCenters: new Float32Array(count * 3),
  extra: {},
});

for (const codec of ["ply", "spz", "sog", "lcc"]) {
  test(`${codec} has a finite source envelope without a 4 GiB floor`, () => {
    const entry = { ...source, codec, shDegree: 0, inputBytes: 32 };
    const limits = sourceLimits(entry);
    const bytes = sourceMemory(entry);
    assert.ok(Number.isSafeInteger(bytes));
    assert.ok(bytes > limits.maxWasmBytes + limits.outputBytes);
    assert.ok(bytes < 128 * 1024 * 1024);
    assert.equal(limits.maxPoints, 1);
    assert.ok(limits.maxInputBytes > 0);
    const memory = new SceneMemory(bytes, 0);
    const release = memory.reserve(bytes);
    assert.ok(release);
    release();
    assert.equal(memory.cpu, 0);
  });
}

test("SOG SH palette admission does not assume palette size follows source count", () => {
  const limits = sourceLimits({ ...source, codec: "sog", shDegree: 3 });
  assert.ok(limits.maxWasmBytes >= 160 * 1024 * 1024);
});

test("budget fields reject unsafe sizes and point limits", () => {
  for (const patch of [
    { maxPoints: 0 },
    { maxPoints: 8_000_001 },
    { maxInputBytes: Number.POSITIVE_INFINITY },
    { maxInputBytes: -1 },
    { maxWasmBytes: 2 ** 32 },
  ])
    assert.throws(() => sourceLimits({ ...source, ...patch }));
});

test("impossible source minimum fails before starting its loader", () => {
  let loads = 0;
  const sources = new SceneSources(
    () => {
      loads++;
    },
    new SceneMemory(sourceMemory(source) - 1, 0),
    new AbortController().signal,
  );
  assert.throws(
    () => sources.acquire(source),
    /requires at least .*maxResidentCpuBytes/,
  );
  assert.equal(loads, 0);
});

test("whole-file header growth is reserved before decoder output and publication", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(ply(5000)));
  const initial = sourceMemory(source);
  const memory = new SceneMemory(initial + 8 * 1024 * 1024, 0);
  let calls = 0;
  let admissionBytes = 0;
  const handlers = createSceneStreamHandlers(
    async (args) => {
      calls++;
      assert.equal(args.decoderLimits.maxPoints, 5000);
      assert.ok(memory.cpu > initial);
      admissionBytes = memory.cpu;
      return data(5000);
    },
    () => {
      throw new Error("Unexpected LCC decode");
    },
  );
  const sources = new SceneSources(
    async (owned, signal) => {
      const info = await handlers.loadSceneSource(
        { id: 1, source: owned, admissionEnabled: true, url: owned.url },
        {
          sendStatus(status) {
            if (status.admission)
              handlers.admitSceneSource({
                id: 1,
                limits: owned.admit(status.admission),
              });
          },
        },
      );
      signal.throwIfAborted();
      return {
        info,
        dispose() {
          handlers.releaseSceneSource({ id: 1 });
        },
      };
    },
    memory,
    new AbortController().signal,
  );
  const lease = sources.acquire(source);
  assert.equal((await lease.promise).info.numSplats, 5000);
  assert.equal(calls, 1);
  assert.equal(memory.cpu, admissionBytes);
  lease.release();
  await sources.dispose();
  await tick();
  assert.equal(memory.cpu, 0);
});

test("denied header re-admission never calls the decoder or publishes a cache", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(ply(5000)));
  const memory = new SceneMemory(sourceMemory(source), 0);
  let calls = 0;
  const handlers = createSceneStreamHandlers(
    async () => {
      calls++;
      return data(5000);
    },
    () => {},
  );
  const sources = new SceneSources(
    async (owned) =>
      handlers.loadSceneSource(
        { id: 2, source: owned, admissionEnabled: true, url: owned.url },
        {
          sendStatus(status) {
            if (status.admission) {
              try {
                owned.admit(status.admission);
              } finally {
                handlers.releaseSceneSource({ id: 2 });
              }
            }
          },
        },
      ),
    memory,
    new AbortController().signal,
  );
  const lease = sources.acquire(source);
  await assert.rejects(lease.promise, /requires at least/);
  assert.equal(calls, 0);
  await assert.rejects(
    handlers.extractSceneRanges({ id: 2, ranges: [{ start: 0, count: 1 }] }),
    /no longer cached/,
  );
  lease.release();
  await sources.dispose();
  await tick();
  assert.equal(memory.cpu, 0);
});

test("announced encoded growth needs admission before reading its response body", async (context) => {
  let reads = 0;
  let canceled = false;
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    headers: new Headers({ "Content-Length": "2097152" }),
    body: {
      getReader() {
        reads++;
        throw new Error("Must not read");
      },
      async cancel() {
        canceled = true;
      },
    },
  }));
  const handlers = createSceneStreamHandlers(
    () => {
      throw new Error("Must not decode");
    },
    () => {},
  );
  await assert.rejects(
    handlers.loadSceneSource(
      { id: 3, source, url: source.url },
      { sendStatus() {} },
    ),
    /larger CPU admission/,
  );
  assert.equal(reads, 0);
  assert.equal(canceled, true);
});

test("canceled decode and asynchronous cache release retain their reservations", async () => {
  const memory = new SceneMemory(sourceMemory(source) * 3, 0);
  let finishDecode;
  let finishRelease;
  const pending = new Promise((resolve) => {
    finishDecode = resolve;
  });
  const sources = new SceneSources(
    async (owned) => {
      if (owned.key === "other") return { dispose() {} };
      await pending;
      return {
        dispose: () =>
          new Promise((resolve) => {
            finishRelease = resolve;
          }),
      };
    },
    memory,
    new AbortController().signal,
  );
  const other = sources.acquire({ ...source, key: "other" });
  await other.promise;
  const lease = sources.acquire(source);
  await tick();
  const held = memory.cpu;
  lease.release();
  await tick();
  assert.equal(memory.cpu, held);
  finishDecode();
  await tick();
  assert.equal(memory.cpu, held);
  finishRelease();
  await assert.rejects(lease.promise, { name: "AbortError" });
  await tick();
  assert.equal(memory.cpu, sourceMemory(source));
  other.release();
  await sources.dispose();
  await tick();
  assert.equal(memory.cpu, 0);
});

test("worker budget imports stay free of renderer dependencies", () => {
  for (const [entry, allowDecoder] of [
    ["limits.js", false],
    ["workerHandlers.js", true],
  ]) {
    const boundary = `data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (!${allowDecoder} && /^gaussian-splat-rs(\\/|$)/.test(specifier))
          throw new Error("Budget policy cannot load the decoder package");
        const resolved = await nextResolve(specifier, context);
        const path = new URL(resolved.url).pathname;
        if (["Splats.js", "IndexedSplats.js", "SogRegionSplats.js"].includes(path.split("/").at(-1)) ||
            path.endsWith("/runtime/wasm.js") || path.endsWith(".wasm"))
          throw new Error("Worker budget cannot load renderer dependencies: " + resolved.url);
        return resolved;
      }
    `)}`;
    const root = new URL(
      `../src/loaders/stream/scene-stream/${entry}`,
      import.meta.url,
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { register } from "node:module";
         register(${JSON.stringify(boundary)});
         await import(${JSON.stringify(root.href)});`,
      ],
      { timeout: 5000, stdio: "pipe" },
    );
  }
});

test("a pinning failure never retains or publishes its worker lease", async () => {
  let worker;
  class FakeWorker {
    disposed = false;
    peakWasmMemoryBytes = 2 * 1024 * 1024;
    constructor(onDispose) {
      worker = this;
      this.onDispose = onDispose;
    }
    async call(name) {
      if (name === "loadSceneSource")
        return { numSplats: 1, numSh: 0, byteLength: 44 };
      if (name === "releaseSceneSource") return;
      throw new Error(`Unexpected RPC ${name}`);
    }
    dispose() {
      if (!this.disposed) {
        this.disposed = true;
        this.onDispose();
      }
    }
  }
  const loader = new SceneStreamLoader(
    { url: "https://scene.invalid/scene.lcc2" },
    () => {},
  );
  loader.workerModule = Promise.resolve({ SceneStreamWorker: FakeWorker });
  const failure = new SceneBudgetError(source.key, "pinWasm heap", 10, 0);
  try {
    await assert.rejects(
      loader.load(
        {
          ...source,
          pinWasm() {
            throw failure;
          },
        },
        new AbortController().signal,
      ),
      (error) => error === failure,
    );
    assert.equal(worker.disposed, true);
    assert.equal(loader.pool.slots[0].references, 0);
    assert.equal(loader.stats.wasmMemoryBytes, 0);
  } finally {
    loader.dispose();
  }
});
