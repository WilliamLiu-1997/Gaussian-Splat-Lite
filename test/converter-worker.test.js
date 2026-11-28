import assert from "node:assert/strict";
import test from "node:test";
import { convertFile } from "../converter/convert-file.js";
import { runWorker } from "../converter/run-worker.js";
import { reportProgress } from "../converter/runtime/host.js";

test("each browser conversion keeps the flags passed at invocation", async (t) => {
  globalThis.crossOriginIsolated = true;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name, _options, run) => run() },
  });
  let received;
  globalThis.Worker = class {
    postMessage({ flags }) {
      received = flags;
      this.onmessage({ data: { done: true } });
    }
    terminate() {}
  };
  t.after(() => {
    Reflect.deleteProperty(navigator, "locks");
    Reflect.deleteProperty(globalThis, "Worker");
    Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  });
  const workingDirectory = {
    async getDirectoryHandle(name, options) {
      if (options?.create) return { name };
      throw new DOMException("", "NotFoundError");
    },
    async removeEntry() {},
  };
  const flags = new Proxy(
    { "sog-blind": new Proxy(["id"], {}), "max-sh": 2 },
    {},
  );
  const job = convertFile(new File([], "scene.ply"), {
    format: "sog",
    flags,
    workingDirectory,
  });
  flags["sog-blind"].push("other");
  flags["max-sh"] = 0;
  await job;
  assert.deepEqual(received, { "sog-blind": ["id"], "max-sh": "2" });
});

test("browser progress events omit an unknown phase percentage and preserve zero", (t) => {
  const events = [];
  globalThis.self = { postMessage: (event) => events.push(event.progress) };
  t.after(() => Reflect.deleteProperty(globalThis, "self"));
  reportProgress("Reading", false, false, true, "Reading", 0);
  reportProgress("Reading", false, false, true, "Reading", 0, 0);
  assert.equal("phasePercent" in events[0], false);
  assert.equal(events[1].phasePercent, 0);
});

test("a rejected progress callback fails the active worker without blocking on pending callbacks", async (t) => {
  globalThis.Worker = class {
    postMessage() {
      this.onmessage({ data: { threads: 1 } });
      this.timer = setImmediate(() => this.onmessage({ data: { done: true } }));
    }
    terminate() {
      clearImmediate(this.timer);
    }
  };
  t.after(() => Reflect.deleteProperty(globalThis, "Worker"));

  const failure = new Error("progress failed");
  await assert.rejects(
    runWorker({}, undefined, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await runWorker({}, undefined, () => new Promise(() => {}));
});
