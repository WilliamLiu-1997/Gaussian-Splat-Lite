import assert from "node:assert/strict";
import test from "node:test";

test("publishing companion files keeps the browser output cancellable until the entry is published", async (t) => {
  globalThis.FileReaderSync = class {};
  t.after(() => Reflect.deleteProperty(globalThis, "FileReaderSync"));
  const { closeSync, mount, openSync, renameSync } = await import(
    "../converter/runtime/files.js"
  );
  const entry = "/model.rad";
  const published = new Int32Array(new SharedArrayBuffer(4));
  mount("/input.ply", {}, {}, { entry, published });

  closeSync(openSync("/chunk.tmp", "wx"));
  renameSync("/chunk.tmp", "/model-0.radc");
  assert.equal(Atomics.load(published, 0), 0);

  closeSync(openSync("/header.tmp", "wx"));
  renameSync("/header.tmp", entry);
  assert.equal(Atomics.load(published, 0), 1);
});
