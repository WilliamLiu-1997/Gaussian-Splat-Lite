import * as THREE from "three";
import * as TSL from "three/tsl";
import type { Node, TextureNode, UniformNode } from "three/webgpu";
import {
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_WIDTH_BITS,
} from "../../data/defines";
import type { Uniforms } from "../uniforms";

import { N, uintTexture } from "./tslCompat";
export { N } from "./tslCompat";

const SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;

const SPLAT_TEX_WIDTH_MASK = (1 << SPLAT_TEX_WIDTH_BITS) - 1;

const SPLAT_TEX_HEIGHT_MASK = (1 << SPLAT_TEX_HEIGHT_BITS) - 1;

export const E = Math.E;

export type UniformType =
  | "bool"
  | "float"
  | "int"
  | "uint"
  | "vec2"
  | "vec3"
  | "vec4"
  | "mat3"
  | "mat4";

export function uniformBinding<Type extends UniformType>(
  uniforms: Uniforms,
  name: string,
  type: Type,
): UniformNode<Type, unknown> {
  const uniform = TSL.uniform as <T extends UniformType>(
    value: unknown,
    type: T,
  ) => UniformNode<T, unknown>;
  return uniform(uniforms[name].value, type).onObjectUpdate(
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
  return uintTexture(placeholder).onObjectUpdate(getTexture);
}

export function load2D<T extends TextureNode<unknown>>(
  binding: T,
  coord: Node<"ivec2">,
): T {
  const texel = binding.load(coord);
  texel.updateMatrix = false;
  return updateTextureLoad(binding, texel);
}

export function loadArray<T extends TextureNode<unknown>>(
  binding: T,
  coord: Node<"ivec3">,
): T {
  return updateTextureLoad(binding, binding.load(coord.xy).depth(coord.z));
}

function updateTextureLoad<T extends TextureNode<unknown>>(
  binding: T,
  texel: T,
) {
  const update = texel.update;
  texel.onObjectUpdate((frame) => {
    // Refresh the texture before Three derives its GL render-target Y flip.
    // Otherwise the first draw still uses the placeholder's orientation.
    binding.update(frame);
    update.call(texel, frame);
    return undefined;
  });
  return texel;
}

export const splatTexCoord = N.Fn(([index]: [Node<"uint">]) => {
  const value = N.uint(index);
  return N.ivec3(
    N.int(value.bitAnd(SPLAT_TEX_WIDTH_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_WIDTH_BITS).bitAnd(SPLAT_TEX_HEIGHT_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_LAYER_BITS)),
  );
});

export const quatVec = N.Fn(
  ([quaternion, vector]: [Node<"vec4">, Node<"vec3">]) => {
    const t = quaternion.xyz.cross(vector).mul(2);
    return vector.add(quaternion.w.mul(t)).add(quaternion.xyz.cross(t));
  },
);

export const quatQuat = N.Fn(
  ([first, second]: [Node<"vec4">, Node<"vec4">]) => {
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
  },
);

export const decodeCenter = N.Fn(([data]: [Node<"uvec4">]) => {
  return N.uintBitsToFloat(data.xyz);
});

export const decodeAlphaShape = N.Fn(([data]: [Node<"uvec4">]) => {
  return N.unpackHalf2x16(data.w);
});

export const decodeRgba = N.Fn(
  ([data, alpha]: [Node<"uvec4">, Node<"float">]) => {
    return N.vec4(N.unpackHalf2x16(data.x), N.unpackHalf2x16(data.y).x, alpha);
  },
);

export const decodeLnScales = N.Fn(([data]: [Node<"uvec4">]) => {
  return N.vec3(N.unpackHalf2x16(data.y).y, N.unpackHalf2x16(data.z));
});

export const decodeQuaternion = N.Fn(([encodedValue]: [Node<"uint">]) => {
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
