import assert from "node:assert/strict";
import test from "node:test";
import { fromHalf, toHalf } from "../src/utils/index.js";

test("half-float conversion handles representative values", () => {
  assert.equal(toHalf(0), 0x0000);
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(fromHalf(0x0000), 0);
  assert.equal(fromHalf(0x3c00), 1);
  assert.equal(fromHalf(0xc000), -2);
  assert.equal(fromHalf(0x7c00), Number.POSITIVE_INFINITY);
});
