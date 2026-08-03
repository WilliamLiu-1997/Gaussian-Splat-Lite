import assert from "node:assert";
import * as THREE from "three";
import {
  floatToUint8,
  resolveTimer,
  uploadU32DataTextureRows,
} from "../src/utils.js";

assert.strictEqual(floatToUint8(0), 0, "floatToUint8 test 1 Failed");
assert.strictEqual(floatToUint8(1), 255, "floatToUint8 test 2 Failed");

const internalTimer = resolveTimer();
assert.strictEqual(
  internalTimer.ownsTimer,
  true,
  "SparkRenderer must update the timer it creates",
);
const externalTimer = new THREE.Timer();
const resolvedExternalTimer = resolveTimer(externalTimer);
assert.strictEqual(resolvedExternalTimer.timer, externalTimer);
assert.strictEqual(
  resolvedExternalTimer.ownsTimer,
  false,
  "SparkRenderer must not update a caller-owned timer",
);

const pixelStoreCalls: Array<[number, unknown]> = [];
const textureStateCalls: string[] = [];
const glTexture = {} as WebGLTexture;
const uploadData = new Uint32Array([1, 2, 3, 4]);
const gl = {
  TEXTURE0: 0,
  TEXTURE_2D: 1,
  PIXEL_UNPACK_BUFFER: 2,
  UNPACK_FLIP_Y_WEBGL: 3,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 4,
  RGBA_INTEGER: 5,
  UNSIGNED_INT: 6,
  getParameter: (parameter: number) => parameter === 3,
  bindBuffer: (_target: number, buffer: unknown) =>
    assert.strictEqual(buffer, null),
  pixelStorei: (parameter: number, value: unknown) =>
    pixelStoreCalls.push([parameter, value]),
  texSubImage2D: (...args: unknown[]) => {
    assert.strictEqual(args[4], 1);
    assert.strictEqual(args[5], 1);
    assert.strictEqual(args[8], uploadData);
  },
};
const texture = {} as THREE.Texture;
const fakeRendererForUpload = {
  getContext: () => gl,
  properties: { get: () => ({ __webglTexture: glTexture }) },
  state: {
    activeTexture: () => textureStateCalls.push("active"),
    bindTexture: (_target: number, value: unknown) => {
      assert.strictEqual(value, glTexture);
      textureStateCalls.push("bind");
    },
    unbindTexture: () => textureStateCalls.push("unbind"),
  },
} as unknown as THREE.WebGLRenderer;
uploadU32DataTextureRows(fakeRendererForUpload, texture, 1, 1, uploadData);
assert.deepStrictEqual(textureStateCalls, ["active", "bind", "unbind"]);
assert.deepStrictEqual(pixelStoreCalls, [
  [3, false],
  [4, false],
  [3, true],
  [4, false],
]);

console.log("✅ All test cases passed!");
