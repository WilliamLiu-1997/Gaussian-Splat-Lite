import assert from "node:assert/strict";
import test from "node:test";
import { Splats } from "../src/Splats.js";
import { SPLAT_TEX_WIDTH } from "../src/defines.js";

test("pads direct splat arrays to a texture-compatible capacity", () => {
  const first = new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const second = new Uint32Array([9, 10, 11, 12, 13, 14, 15, 16]);
  const data = new Splats({ splatArrays: [first, second] });

  assert.equal(data.getNumSplats(), 2);
  assert.equal(data.splatArrays[0].length, SPLAT_TEX_WIDTH * 4);
  assert.equal(data.splatArrays[1].length, SPLAT_TEX_WIDTH * 4);
  assert.deepEqual(data.splatArrays[0].slice(0, first.length), first);
  assert.deepEqual(data.splatArrays[1].slice(0, second.length), second);
  assert.equal(data.splatArrays[0][first.length], 0);
  assert.equal(data.splatArrays[1][second.length], 0);

  const [firstTexture, secondTexture] = data.getSplatTextures();
  assert.equal(firstTexture.image.width, SPLAT_TEX_WIDTH);
  assert.equal(firstTexture.image.height, 1);
  assert.equal(firstTexture.image.depth, 1);
  assert.equal(firstTexture.image.data, data.splatArrays[0]);
  assert.equal(secondTexture.image.data, data.splatArrays[1]);
  data.dispose();
});

test("preserves already texture-compatible direct arrays", () => {
  const first = new Uint32Array(SPLAT_TEX_WIDTH * 4);
  const second = new Uint32Array(SPLAT_TEX_WIDTH * 4);
  const data = new Splats({
    splatArrays: [first, second],
    numSplats: 1,
  });

  assert.equal(data.splatArrays[0], first);
  assert.equal(data.splatArrays[1], second);
  assert.equal(data.getNumSplats(), 1);
  data.dispose();
});

test("rejects malformed direct splat arrays", () => {
  assert.throws(
    () =>
      new Splats({
        splatArrays: [new Uint32Array(4), new Uint32Array(8)],
      }),
    /same length/,
  );
  assert.throws(
    () =>
      new Splats({
        splatArrays: [new Uint32Array(5), new Uint32Array(5)],
      }),
    /complete four-word records/,
  );
  assert.throws(
    () =>
      new Splats({
        splatArrays: [new Uint32Array(4), new Uint32Array(4)],
        numSplats: 2,
      }),
    /integer within splatArrays/,
  );
});
