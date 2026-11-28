import assert from "node:assert/strict";
import test from "node:test";
import { Writeback } from "../bin/rad/writeback.js";

test("failed writeback preserves the submission or completion error through cleanup", () => {
  const failure = new Error("disk full");
  const fail = () => {
    throw failure;
  };
  const rejected = new Writeback(4, fail, () => {});
  assert.throws(
    () => rejected.wrote(1, 3),
    (error) => error === failure,
  );
  rejected.wait(false);

  for (const result of [fail, true]) {
    const submitted = new Writeback(
      4,
      (_files, state) => {
        Atomics.store(state, 1, -5);
        Atomics.store(state, 0, 0);
        return result;
      },
      () => {},
    );
    submitted.wrote(1, 3);
    assert.throws(
      () => submitted.wait(),
      result === fail ? (error) => error === failure : /Unable to write back/,
    );
    submitted.wait(false);
  }
});
