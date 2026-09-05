import * as THREE from "three";
import * as TSL from "three/tsl";
import {
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_WIDTH_BITS,
} from "../../data/defines";
import type { Uniforms } from "../uniforms";

// biome-ignore lint/suspicious/noExplicitAny: TSL exposes a dynamic fluent API.
export type TSLNode = any;

const N = TSL as Record<string, TSLNode>;

export const SPLAT_TEX_LAYER_BITS =
  SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;

export const SPLAT_TEX_WIDTH_MASK = (1 << SPLAT_TEX_WIDTH_BITS) - 1;

export const SPLAT_TEX_HEIGHT_MASK = (1 << SPLAT_TEX_HEIGHT_BITS) - 1;

export const E = Math.E;

export function uniformBinding(
  uniforms: Uniforms,
  name: string,
  type?: string,
) {
  return N.uniform(uniforms[name].value, type).onObjectUpdate(
    () => uniforms[name].value,
  );
}

export function textureBinding(
  uniforms: Uniforms,
  name: string,
  array = false,
) {
  const data = new Uint32Array(4);
  const placeholder = array
    ? new THREE.DataArrayTexture(data, 1, 1, 1)
    : new THREE.DataTexture(data, 1, 1);
  placeholder.format = THREE.RGBAIntegerFormat;
  placeholder.type = THREE.UnsignedIntType;
  placeholder.magFilter = THREE.NearestFilter;
  placeholder.minFilter = THREE.NearestFilter;
  placeholder.generateMipmaps = false;
  placeholder.needsUpdate = true;

  const getTexture = () => uniforms[name].value as THREE.Texture;
  return N.textureLoad(placeholder).onObjectUpdate(getTexture);
}

export function load2D(binding: TSLNode, coord: TSLNode) {
  const texel = binding.load(coord);
  texel.setUpdateMatrix(false);
  return texel;
}

export function loadArray(binding: TSLNode, coord: TSLNode) {
  return binding.load(coord.xy).depth(coord.z);
}

export const splatTexCoord = N.Fn(([index]: TSLNode[]) => {
  const value = N.uint(index);
  return N.ivec3(
    N.int(value.bitAnd(SPLAT_TEX_WIDTH_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_WIDTH_BITS).bitAnd(SPLAT_TEX_HEIGHT_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_LAYER_BITS)),
  );
});

export const quatVec = N.Fn(([quaternion, vector]: TSLNode[]) => {
  const t = quaternion.xyz.cross(vector).mul(2);
  return vector.add(quaternion.w.mul(t)).add(quaternion.xyz.cross(t));
});

export const quatQuat = N.Fn(([first, second]: TSLNode[]) => {
  return N.vec4(
    first.w
      .mul(second.x)
      .add(first.x.mul(second.w))
      .add(first.y.mul(second.z))
      .sub(first.z.mul(second.y)),
    first.w
      .mul(second.y)
      .sub(first.x.mul(second.z))
      .add(first.y.mul(second.w))
      .add(first.z.mul(second.x)),
    first.w
      .mul(second.z)
      .add(first.x.mul(second.y))
      .sub(first.y.mul(second.x))
      .add(first.z.mul(second.w)),
    first.w
      .mul(second.w)
      .sub(first.x.mul(second.x))
      .sub(first.y.mul(second.y))
      .sub(first.z.mul(second.z)),
  );
});

export const decodeCenter = N.Fn(([data]: TSLNode[]) => {
  return N.uintBitsToFloat(data.xyz);
});

export const decodeAlphaShape = N.Fn(([data]: TSLNode[]) => {
  return N.unpackHalf2x16(data.w);
});

export const decodeRgba = N.Fn(([data, alpha]: TSLNode[]) => {
  return N.vec4(N.unpackHalf2x16(data.x), N.unpackHalf2x16(data.y).x, alpha);
});

export const decodeLnScales = N.Fn(([data]: TSLNode[]) => {
  return N.vec3(N.unpackHalf2x16(data.y).y, N.unpackHalf2x16(data.z));
});

export const decodeQuaternion = N.Fn(([encodedValue]: TSLNode[]) => {
  const encoded = N.uint(encodedValue);
  const quantU = encoded.bitAnd(0x3ff);
  const quantV = encoded.shiftRight(10).bitAnd(0x3ff);
  const angleInt = encoded.shiftRight(20);
  const folded = N.vec2(N.float(quantU), N.float(quantV))
    .div(1023)
    .mul(2)
    .sub(1);
  const axis = N.vec3(
    folded,
    N.float(1).sub(folded.x.abs()).sub(folded.y.abs()),
  ).toVar();
  const t = axis.z.negate().max(0);
  axis.x.addAssign(N.select(axis.x.greaterThanEqual(0), t.negate(), t));
  axis.y.addAssign(N.select(axis.y.greaterThanEqual(0), t.negate(), t));
  axis.assign(axis.normalize());

  const halfTheta = N.float(angleInt)
    .div(4095)
    .mul(Math.PI * 0.5);
  return N.vec4(axis.mul(halfTheta.sin()), halfTheta.cos());
});
