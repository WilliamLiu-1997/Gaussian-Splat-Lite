import * as THREE from "three";

// Miscellaneous utility functions for Gaussian Splat Lite

import {
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines.js";

export const threeRevision = Number.parseInt(THREE.REVISION);
export const threeMrtArray = threeRevision >= 179;

const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16buffer = supportsFloat16Array
  ? new globalThis["Float16Array" as keyof typeof globalThis](1)
  : null;
const u16buffer = new Uint16Array(f16buffer?.buffer);

// Reinterpret the bits of a float32 as a uint32
export function floatBitsToUint(f: number): number {
  f32buffer[0] = f;
  return u32buffer[0];
}

// Reinterpret the bits of a uint32 as a float32
export function uintBitsToFloat(u: number): number {
  u32buffer[0] = u;
  return f32buffer[0];
}

export const toHalf = supportsFloat16Array ? toHalfNative : toHalfJS;
export const fromHalf = supportsFloat16Array ? fromHalfNative : fromHalfJS;

// Encode a number as a float16, stored as a uint16 number.
function toHalfNative(f: number): number {
  f16buffer[0] = f;
  return u16buffer[0];
}

// Encode a number as a float16, stored as a uint16 number.
function toHalfJS(f: number): number {
  // Store the value into the shared Float32 array.
  f32buffer[0] = f;
  const bits = u32buffer[0];

  // Extract sign (1 bit), exponent (8 bits), and fraction (23 bits)
  const sign = (bits >> 31) & 0x1;
  const exp = (bits >> 23) & 0xff;
  const frac = bits & 0x7fffff;
  const halfSign = sign << 15;

  // Handle special cases: NaN and Infinity
  if (exp === 0xff) {
    // NaN: set all exponent bits to 1 and some nonzero fraction bits.
    if (frac !== 0) {
      return halfSign | 0x7fff;
    }
    // Infinity
    return halfSign | 0x7c00;
  }

  // Adjust the exponent from float32 bias (127) to float16 bias (15)
  const newExp = exp - 127 + 15;

  // Handle overflow: too large to represent in half precision.
  if (newExp >= 0x1f) {
    return halfSign | 0x7c00; // Infinity
  }
  if (newExp <= 0) {
    // Handle subnormals and underflow.
    if (newExp < -10) {
      // Too small: underflows to zero.
      return halfSign;
    }
    // Convert to subnormal: add the implicit leading 1 to the fraction,
    // then shift to align with the half-precision's 10 fraction bits.
    const subFrac = (frac | 0x800000) >> (1 - newExp + 13);
    return halfSign | subFrac;
  }

  // Normalized half-precision number: shift fraction to fit into 10 bits.
  const halfFrac = frac >> 13;
  return halfSign | (newExp << 10) | halfFrac;
}

// Convert a float16 stored as a uint16 number back to a float32.
function fromHalfNative(u: number): number {
  u16buffer[0] = u;
  return f16buffer[0];
}

// Convert a float16 stored as a uint16 number back to a float32.
function fromHalfJS(h: number): number {
  // Extract the sign (1 bit), exponent (5 bits), and fraction (10 bits)
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;

  let f32bits: number;

  if (exp === 0) {
    if (frac === 0) {
      // Zero (positive or negative)
      f32bits = sign << 31;
    } else {
      // Subnormal half-precision number.
      // Normalize the subnormal number:
      let mant = frac;
      let e = -14; // For half, the exponent for subnormals is fixed at -14.
      // Shift left until the implicit leading 1 is in place.
      while ((mant & 0x400) === 0) {
        // 0x400 === 1 << 10
        mant <<= 1;
        e--;
      }
      // Remove the leading 1 (which is now implicit)
      mant &= 0x3ff;
      // Convert the half exponent (e) to the 32-bit float exponent:
      const newExp = e + 127; // 32-bit float bias is 127.
      const newFrac = mant << 13; // Align to 23-bit fraction (23 - 10 = 13)
      f32bits = (sign << 31) | (newExp << 23) | newFrac;
    }
  } else if (exp === 0x1f) {
    // Handle special cases for Infinity and NaN.
    if (frac === 0) {
      // Infinity
      f32bits = (sign << 31) | 0x7f800000;
    } else {
      // NaN (we choose a quiet NaN)
      f32bits = (sign << 31) | 0x7fc00000;
    }
  } else {
    // Normalized half-precision number.
    // Adjust exponent from half (bias 15) to float32 (bias 127)
    const newExp = exp - 15 + 127;
    const newFrac = frac << 13;
    f32bits = (sign << 31) | (newExp << 23) | newFrac;
  }

  // Write the 32-bit bit pattern to the shared buffer,
  // then read it as a float32 to return a JavaScript number.
  u32buffer[0] = f32bits;
  return f32buffer[0];
}

// Recursively finds all ArrayBuffers in an object and returns them as an array
// to use as transferable objects to send between workers.
export function getTransferable(ctx: unknown): Transferable[] {
  const buffers: Transferable[] = [];
  const seen = new Set();

  function traverse(obj: unknown) {
    if (obj && typeof obj === "object" && !seen.has(obj)) {
      seen.add(obj);

      if (obj instanceof ArrayBuffer) {
        buffers.push(obj);
      } else if (ArrayBuffer.isView(obj)) {
        // Handles TypedArrays and DataView
        buffers.push(obj.buffer as ArrayBuffer);
      } else if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else {
        Object.values(obj).forEach(traverse);
      }
    }
  }

  traverse(ctx);
  return buffers;
}

export function encodeSplat(
  splatArrays: [Uint32Array, Uint32Array],
  index: number,
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  quatX: number,
  quatY: number,
  quatZ: number,
  quatW: number,
  opacity: number,
  r: number,
  g: number,
  b: number,
) {
  const i4 = index * 4;
  const [splatA, splatB] = splatArrays;
  splatA[i4] = floatBitsToUint(x);
  splatA[i4 + 1] = floatBitsToUint(y);
  splatA[i4 + 2] = floatBitsToUint(z);
  splatA[i4 + 3] = toHalf(opacity);
  splatB[i4] = toHalf(r) | (toHalf(g) << 16);
  splatB[i4 + 1] = toHalf(b) | (toHalf(Math.log(scaleX)) << 16);
  splatB[i4 + 2] = toHalf(Math.log(scaleY)) | (toHalf(Math.log(scaleZ)) << 16);
  splatB[i4 + 3] = encodeQuatOctXy1010R12(quatX, quatY, quatZ, quatW);
}

export function decodeSplat(
  splatArrays: [Uint32Array, Uint32Array],
  index: number,
): {
  center: THREE.Vector3;
  scales: THREE.Vector3;
  quaternion: THREE.Quaternion;
  color: THREE.Color;
  opacity: number;
} {
  // Returns a static object which is reused each time
  const result = splatFields;
  const i4 = index * 4;
  const [splatA, splatB] = splatArrays;
  result.center.x = uintBitsToFloat(splatA[i4]);
  result.center.y = uintBitsToFloat(splatA[i4 + 1]);
  result.center.z = uintBitsToFloat(splatA[i4 + 2]);
  result.opacity = fromHalf(splatA[i4 + 3] & 0xffff);
  result.color.r = fromHalf(splatB[i4] & 0xffff);
  result.color.g = fromHalf(splatB[i4] >>> 16);
  result.color.b = fromHalf(splatB[i4 + 1] & 0xffff);
  result.scales.x = Math.exp(fromHalf(splatB[i4 + 1] >>> 16));
  result.scales.y = Math.exp(fromHalf(splatB[i4 + 2] & 0xffff));
  result.scales.z = Math.exp(fromHalf(splatB[i4 + 2] >>> 16));
  decodeQuatOctXy1010R12(splatB[i4 + 3], result.quaternion);
  return result;
}

const splatCenter = new THREE.Vector3();
const splatScales = new THREE.Vector3();
const splatQuaternion = new THREE.Quaternion();
const splatColor = new THREE.Color();
const splatFields = {
  center: splatCenter,
  scales: splatScales,
  quaternion: splatQuaternion,
  color: splatColor,
  opacity: 0.0,
};

// Compute a texture array size that is large enough to fit numSplats. The most
// common 2D texture size in WebGL2 is 4096x4096 which only allows for 16M splats,
// so Gaussian Splat Lite stores Gsplat data in a 2D texture array, which most platforms support
// up to 2048x2048x2048 = 8G splats. Allocations that fit within a single 2D texture
// array layer will be rounded up to fill an entire texture row. Once a texture
// array layer is filled, the allocation will be rounded up to fill an entire layer.
// This is done so the entire set of splats can be covered by min/max coords across
// each dimension.
export function getTextureSize(numSplats: number): {
  width: number;
  height: number;
  depth: number;
  maxSplats: number;
} {
  // Compute a texture array size that is large enough to fit numSplats.
  // The width is always 2048, the height sized to fit the splats but no larger than 2048.
  // The depth is the number of layers needed to fit the splats.
  // maxSplats is computed as the new total available splats that can be stored.
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width)),
  );
  const depth = Math.ceil(numSplats / (width * height));
  const maxSplats = width * height * depth;
  return { width, height, depth, maxSplats };
}

// "Identity" vertex shader that just passes through the position.
export const IDENT_VERTEX_SHADER = `
precision highp float;

in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function encodeQuatOctXy1010R12(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number {
  const qlen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  // Force the minimal representation (q.w >= 0)
  const qnx = (qw < 0 ? -qx : qx) / qlen;
  const qny = (qw < 0 ? -qy : qy) / qlen;
  const qnz = (qw < 0 ? -qz : qz) / qlen;
  const qnw = (qw < 0 ? -qw : qw) / qlen;
  // Compute the rotation angle θ in [0, π]
  const theta = 2 * Math.acos(qnw);
  // Recover the rotation axis (default to (1,0,0) for near-zero rotation)
  const xyz_norm = Math.sqrt(qnx * qnx + qny * qny + qnz * qnz);
  const axisX = xyz_norm < 1e-6 ? 1 : qnx / xyz_norm;
  const axisY = xyz_norm < 1e-6 ? 0 : qny / xyz_norm;
  const axisZ = xyz_norm < 1e-6 ? 0 : qnz / xyz_norm;

  // --- Folded Octahedral Mapping (inline) ---
  // Compute p = (axis.x, axis.y) / (|axis.x|+|axis.y|+|axis.z|)
  const sum = Math.abs(axisX) + Math.abs(axisY) + Math.abs(axisZ);
  let p_x = axisX / sum;
  let p_y = axisY / sum;
  // Fold the lower hemisphere.
  if (axisZ < 0) {
    const tmp = p_x;
    p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
    p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
  }
  // Remap from [-1,1] to [0,1]
  const u_f = p_x * 0.5 + 0.5;
  const v_f = p_y * 0.5 + 0.5;
  // Quantize to 10 bits (0..1023)
  const quantU = Math.round(u_f * 1023);
  const quantV = Math.round(v_f * 1023);
  // --- Angle Quantization: Quantize θ ∈ [0,π] to 12 bits (0..4095) ---
  const angleInt = Math.round(theta * (4095 / Math.PI));

  // Pack into 32 bits: bits [0–9]: quantU, [10–19]: quantV, [20–31]: angleInt.
  return (angleInt << 20) | (quantV << 10) | quantU;
}

export function decodeQuatOctXy1010R12(
  encoded: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  // Extract 10‐bit quantU and quantV, and 12‐bit angleInt.
  const quantU = encoded & 0x3ff; // bits 0–9
  const quantV = (encoded >>> 10) & 0x3ff; // bits 10–19
  const angleInt = (encoded >>> 20) & 0xfff; // bits 20–31

  // Recover u and v in [0,1] then map to [-1,1]
  const u_f = quantU / 1023;
  const v_f = quantV / 1023;
  let f_x = (u_f - 0.5) * 2;
  let f_y = (v_f - 0.5) * 2;
  // Inverse folded mapping: recover z from the constraint |p_x|+|p_y|+z = 1.
  const f_z = 1 - (Math.abs(f_x) + Math.abs(f_y));
  const t = Math.max(-f_z, 0);
  f_x += f_x >= 0 ? -t : t;
  f_y += f_y >= 0 ? -t : t;
  const axisLen = Math.sqrt(f_x * f_x + f_y * f_y + f_z * f_z);
  const axisX = axisLen < 1e-6 ? 0 : f_x / axisLen;
  const axisY = axisLen < 1e-6 ? 0 : f_y / axisLen;
  const axisZ = axisLen < 1e-6 ? 0 : f_z / axisLen;

  // Decode the angle: θ ∈ [0,π]
  const theta = (angleInt / 4095) * Math.PI;
  const halfTheta = theta * 0.5;
  const s = Math.sin(halfTheta);
  const w = Math.cos(halfTheta);
  // Reconstruct the quaternion from axis-angle: (axis * sin(θ/2), cos(θ/2))
  out.set(axisX * s, axisY * s, axisZ * s, w);
  return out;
}

export function uploadU32DataTextureRows(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  width: number,
  rows: number,
  data: Uint32Array,
) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const props = renderer.properties.get(texture) as {
    __webglTexture: WebGLTexture;
  };
  const glTexture = props?.__webglTexture;
  if (!glTexture) {
    throw new Error("texture not found");
  }

  // renderer.state.pixelStorei is only available in newer Three.js releases,
  // so preserve these WebGL flags explicitly across the direct texture upload.
  const currentFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const currentPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  renderer.state.activeTexture(gl.TEXTURE0);
  renderer.state.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    rows,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    data,
  );
  renderer.state.unbindTexture();
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, currentFlipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, currentPremultiply);
}

export function resolveTimer(timer?: THREE.Timer): {
  timer: THREE.Timer;
  ownsTimer: boolean;
} {
  return {
    timer: timer ?? new THREE.Timer(),
    // A caller-supplied timer may be shared with other systems, so only update
    // the timer that Gaussian Splat Lite creates and owns itself.
    ownsTimer: timer === undefined,
  };
}
