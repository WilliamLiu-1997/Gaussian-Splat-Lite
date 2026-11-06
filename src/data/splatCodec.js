import { fromHalf, toHalf } from "../utils/numeric.js";
const F32_EPSILON = 1.192_092_895_507_812_5e-7;
const SMALLEST_THREE_SCALE = 511 * Math.SQRT2;
const SMALLEST_THREE_DECODE_SCALE = 1 / SMALLEST_THREE_SCALE;
const SMALLEST_THREE_IDENTITY = 0xc0000000;
const SH_SCALE_LOOKUP = Float64Array.from(
  { length: 32 },
  (_, exponent) => 2 ** (exponent - 15) / 255,
);
export function decodeSplatOpacity(word) {
  const shapeAmount = fromHalf(word >>> 16);
  if (shapeAmount > 0) {
    const kernelShape = Math.min(shapeAmount, 1) * 4 + 1;
    return Math.exp((kernelShape * kernelShape - 1) / Math.E);
  }
  return fromHalf(word & 0xffff);
}
export function encodeSplatOpacity(opacity) {
  if (opacity > 0 && opacity <= 1) return toHalf(opacity);
  const value = Math.max(opacity || 0, 0);
  if (value > 1) {
    const shapeAmount = 0.25 * (Math.sqrt(Math.log(value) * Math.E + 1) - 1);
    // Match the renderer's shape range [0, 1].
    return (toHalf(1) | (toHalf(Math.min(shapeAmount, 1)) << 16)) >>> 0;
  }
  return toHalf(value);
}
export function decodeShRgbToArray(word, output, base = 0, stride = 1) {
  const exponentAndSigns = word >>> 24;
  const multiplier = SH_SCALE_LOOKUP[exponentAndSigns >>> 3];
  for (let component = 0; component < 3; component += 1) {
    const magnitude = ((word >>> (component * 8)) & 0xff) * multiplier;
    output[base + component * stride] =
      exponentAndSigns & (1 << component) ? -magnitude : magnitude;
  }
}

export function decodeQuatSmallestThree32ToArray(
  word,
  output,
  base = 0,
  stride = 1,
) {
  const omitted = word >>> 30;
  let sum = 0;
  let bits = word;
  for (let component = 0; component < 4; component += 1) {
    if (component === omitted) continue;
    const value =
      (((bits & 0x3ff) ^ 0x200) - 0x200) * SMALLEST_THREE_DECODE_SCALE;
    output[base + component * stride] = value;
    sum += value * value;
    bits >>>= 10;
  }
  output[base + omitted * stride] = Math.sqrt(1 - sum);
}

function encodeSmallestThree(qx, qy, qz, qw, minimumLengthSquared) {
  const lengthSquared = qx * qx + qy * qy + qz * qz + qw * qw;
  if (
    !Number.isFinite(lengthSquared) ||
    lengthSquared <= minimumLengthSquared
  ) {
    return undefined;
  }
  const quaternion = [qx, qy, qz, qw];
  let omitted = 0;
  for (let component = 1; component < 4; component += 1) {
    if (Math.abs(quaternion[component]) > Math.abs(quaternion[omitted])) {
      omitted = component;
    }
  }
  const multiplier =
    (quaternion[omitted] < 0 ? -1 : 1) *
    (SMALLEST_THREE_SCALE / Math.sqrt(lengthSquared));
  let word = omitted << 30;
  let shift = 0;
  for (let component = 0; component < 4; component += 1) {
    if (component === omitted) continue;
    const value = quaternion[component] * multiplier;
    // Nearest integer, ties away from zero, in all four implementations.
    const quantized = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
    word |= (quantized & 0x3ff) << shift;
    shift += 10;
  }
  return word >>> 0;
}

export function encodeQuatSmallestThree32(qx, qy, qz, qw) {
  return encodeSmallestThree(qx, qy, qz, qw, 0) ?? SMALLEST_THREE_IDENTITY;
}

export function tryEncodeQuatSmallestThree32(qx, qy, qz, qw) {
  return encodeSmallestThree(qx, qy, qz, qw, F32_EPSILON);
}
