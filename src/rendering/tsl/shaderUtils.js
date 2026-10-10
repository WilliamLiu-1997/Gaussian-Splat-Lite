import * as N from "three/tsl";
import { NodeUpdateType } from "three/webgpu";
import {
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_WIDTH_BITS,
} from "../../data/defines.js";
export { N };
const SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_WIDTH_MASK = (1 << SPLAT_TEX_WIDTH_BITS) - 1;
const SPLAT_TEX_HEIGHT_MASK = (1 << SPLAT_TEX_HEIGHT_BITS) - 1;
export const E = Math.E;
/** Texture loads without a sampler, preserving the texture's integer format. */
export function uintTexture(texture) {
  return N.texture(texture).setSampler(false);
}
export function uniformBinding(uniforms, name, type) {
  return N.uniform(uniforms[name].value, type).onObjectUpdate(
    () => uniforms[name].value,
  );
}
export function textureBinding(uniforms, name) {
  const getTexture = () => uniforms[name].value;
  const binding = uintTexture(getTexture()).onObjectUpdate(getTexture);
  // Dynamic bindings stay distinct even while they share a texture.
  binding.mergeable = false;
  return binding;
}
export function load2D(binding, coord) {
  const texel = binding.load(coord);
  texel.updateMatrix = false;
  return updateTextureLoad(binding, texel);
}
export function loadArray(binding, coord) {
  return updateTextureLoad(binding, binding.load(coord.xy).depth(coord.z));
}
function updateTextureLoad(binding, texel) {
  texel.updateBeforeType = NodeUpdateType.OBJECT;
  texel.updateBefore = (frame) => {
    // Bind the real texture before shared uniforms derive the GL target Y flip.
    frame.updateNode(binding);
    return undefined;
  };
  return texel;
}
export const splatTexCoord = N.Fn(([index]) => {
  const value = N.uint(index);
  return N.ivec3(
    N.int(value.bitAnd(SPLAT_TEX_WIDTH_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_WIDTH_BITS).bitAnd(SPLAT_TEX_HEIGHT_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_LAYER_BITS)),
  );
});
export const quatVec = N.Fn(([quaternion, vector]) => {
  const t = quaternion.xyz.cross(vector).mul(2);
  return vector.add(quaternion.w.mul(t)).add(quaternion.xyz.cross(t));
});
export const quatQuat = N.Fn(([first, second]) => {
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
export const decodeCenter = N.Fn(([data]) => {
  return N.uintBitsToFloat(data.xyz);
});
export const decodeAlphaShape = N.Fn(([data]) => {
  return N.unpackHalf2x16(data.w);
});
export const decodeRgba = N.Fn(([data, alpha]) => {
  return N.vec4(N.unpackHalf2x16(data.x), N.unpackHalf2x16(data.y).x, alpha);
});
export const decodeLnScales = N.Fn(([data]) => {
  return N.vec3(N.unpackHalf2x16(data.y).y, N.unpackHalf2x16(data.z));
});
/** Unit vector of octahedral coordinates in [-1, 1]. Call inside a TSL Fn. */
export function decodeOctahedral(folded) {
  const vector = N.vec3(
    folded,
    N.float(1).sub(folded.x.abs()).sub(folded.y.abs()),
  ).toVar();
  const t = vector.z.negate().max(0);
  vector.x.addAssign(N.select(vector.x.greaterThanEqual(0), t.negate(), t));
  vector.y.addAssign(N.select(vector.y.greaterThanEqual(0), t.negate(), t));
  return vector.normalize();
}
export const decodeQuaternion = N.Fn(([encodedValue]) => {
  const encoded = N.uint(encodedValue);
  const quantU = encoded.bitAnd(0x3ff);
  const quantV = encoded.shiftRight(10).bitAnd(0x3ff);
  const angleInt = encoded.shiftRight(20);
  const axis = decodeOctahedral(
    N.vec2(N.float(quantU), N.float(quantV)).div(1023).mul(2).sub(1),
  );
  const halfTheta = N.float(angleInt)
    .div(4095)
    .mul(Math.PI * 0.5);
  return N.vec4(axis.mul(halfTheta.sin()), halfTheta.cos());
});
