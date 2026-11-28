import assert from "node:assert/strict";
import test from "node:test";
import { ConversionController } from "../converter/index.js";

test("a conversion controller wakes paused callers on resume and abort", async (t) => {
  globalThis.crossOriginIsolated = true;
  t.after(() => Reflect.deleteProperty(globalThis, "crossOriginIsolated"));

  const controller = new ConversionController();
  controller.pause();
  const resumed = controller.waitWhilePaused();
  controller.resume();
  await resumed;
  assert.equal(controller.paused, false);

  controller.pause();
  const aborted = controller.waitWhilePaused();
  const elapsed = controller.elapsedMilliseconds;
  controller.abort("stopped");
  await aborted;
  controller.pause();
  controller.resume();
  assert.equal(controller.paused, false);
  assert.equal(controller.signal.reason, "stopped");
  assert.equal(controller.elapsedMilliseconds, elapsed);
});
