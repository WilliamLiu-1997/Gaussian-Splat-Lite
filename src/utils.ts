import * as THREE from "three";

// Miscellaneous utility functions for Gaussian Splat Lite

import {
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines.js";
import {
  decodeQuatOctXy1010R12ToArray,
  decodeSplatOpacity,
} from "./splatCodec";
export { fromHalf, toHalf } from "./float16";
export { encodeQuatOctXy1010R12 } from "./splatCodec";
export { getTransferable } from "./transferable";
import { fromHalf } from "./float16";

export const threeRevision = Number.parseInt(THREE.REVISION);
export const threeMrtArray = threeRevision >= 179;

const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);

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
  result.opacity = decodeSplatOpacity(splatA[i4 + 3]);
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

const decodedQuaternion = [0, 0, 0, 1];

export function decodeQuatOctXy1010R12(
  encoded: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  decodeQuatOctXy1010R12ToArray(encoded, decodedQuaternion);
  out.set(
    decodedQuaternion[0],
    decodedQuaternion[1],
    decodedQuaternion[2],
    decodedQuaternion[3],
  );
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
