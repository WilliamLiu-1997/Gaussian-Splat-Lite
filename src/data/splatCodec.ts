import { fromHalf, toHalf } from "../utils/numeric";

const MAX_SPLAT_OPACITY = 1000;
const F32_EPSILON = 1.192_092_895_507_812_5e-7;
const ENCODED_IDENTITY_QUATERNION = (512 << 10) | 1023;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function decodeSplatOpacity(word: number) {
  const shapeAmount = fromHalf(word >>> 16);
  if (shapeAmount > 0) {
    const kernelShape = shapeAmount * 4 + 1;
    return Math.min(
      MAX_SPLAT_OPACITY,
      Math.exp((kernelShape * kernelShape - 1) / Math.E),
    );
  }
  return fromHalf(word & 0xffff);
}

export function encodeSplatOpacity(opacity: number) {
  if (opacity > 0 && opacity <= 1) return toHalf(opacity);
  const value = clamp(opacity, 0, MAX_SPLAT_OPACITY);
  if (value > 1) {
    const shapeAmount = 0.25 * (Math.sqrt(Math.log(value) * Math.E + 1) - 1);
    return (toHalf(1) | (toHalf(shapeAmount) << 16)) >>> 0;
  }
  return toHalf(value);
}

type QuaternionOutput = Float32Array | number[];

export function decodeQuatOctXy1010R12ToArray(
  word: number,
  output: QuaternionOutput,
  base = 0,
  stride = 1,
) {
  const u = word & 0x3ff;
  const v = (word >>> 10) & 0x3ff;
  const angle = word >>> 20;
  let x = (u / 1023) * 2 - 1;
  let y = (v / 1023) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const fold = Math.max(-z, 0);
  x += x >= 0 ? -fold : fold;
  y += y >= 0 ? -fold : fold;
  const inverseLength = 1 / Math.sqrt(x * x + y * y + z * z);
  const halfTheta = (angle / 4095) * 0.5 * Math.PI;
  const sine = Math.sin(halfTheta);
  output[base] = x * inverseLength * sine;
  output[base + stride] = y * inverseLength * sine;
  output[base + stride * 2] = z * inverseLength * sine;
  output[base + stride * 3] = Math.cos(halfTheta);
}

function encodeQuaternion(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  minimumLengthSquared: number,
) {
  const lengthSquared = qx * qx + qy * qy + qz * qz + qw * qw;
  if (
    !Number.isFinite(lengthSquared) ||
    lengthSquared <= minimumLengthSquared
  ) {
    return undefined;
  }
  if (qx === 0 && qy === 0 && qz === 0) {
    return ENCODED_IDENTITY_QUATERNION;
  }

  const inverseLength = 1 / Math.sqrt(lengthSquared);
  let x = qx * inverseLength;
  let y = qy * inverseLength;
  let z = qz * inverseLength;
  let w = qw * inverseLength;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }

  const theta = 2 * Math.acos(clamp(w, 0, 1));
  const sine = Math.sin(theta * 0.5);
  const axisX = Math.abs(sine) < 1e-6 ? 1 : x / sine;
  const axisY = Math.abs(sine) < 1e-6 ? 0 : y / sine;
  const axisZ = Math.abs(sine) < 1e-6 ? 0 : z / sine;
  const sum = Math.abs(axisX) + Math.abs(axisY) + Math.abs(axisZ);
  let octX = axisX / sum;
  let octY = axisY / sum;
  if (axisZ < 0) {
    const previousX = octX;
    octX = (1 - Math.abs(octY)) * (octX >= 0 ? 1 : -1);
    octY = (1 - Math.abs(previousX)) * (octY >= 0 ? 1 : -1);
  }

  const u = Math.round(clamp((octX * 0.5 + 0.5) * 1023, 0, 1023));
  const v = Math.round(clamp((octY * 0.5 + 0.5) * 1023, 0, 1023));
  const angle = Math.round(clamp((theta / Math.PI) * 4095, 0, 4095));
  return ((angle << 20) | (v << 10) | u) >>> 0;
}

export function encodeQuatOctXy1010R12(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number {
  return (encodeQuaternion(qx, qy, qz, qw, 0) ?? 0) | 0;
}

export function tryEncodeQuatOctXy1010R12(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
) {
  return encodeQuaternion(qx, qy, qz, qw, F32_EPSILON);
}
