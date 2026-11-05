import * as N from "three/tsl";
import { TextureNode } from "three/webgpu";
import {
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_WIDTH_BITS,
} from "../../data/defines.js";
export { N };
const SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_WIDTH_MASK = (1 << SPLAT_TEX_WIDTH_BITS) - 1;
const SPLAT_TEX_HEIGHT_MASK = (1 << SPLAT_TEX_HEIGHT_BITS) - 1;
export const E = Math.E;
// Data textures use raw texel coordinates on both backends. The constructor
// also disables UV transforms on the clones made by load() and depth().
class RawTextureNode extends TextureNode {
  constructor(...args) {
    super(...args);
    this.updateMatrix = false;
  }
  setupUV(_builder, uvNode) {
    return uvNode;
  }
}
/** Integer data texel loads without image UV transforms or backend Y flips. */
export function uintTexture(texture) {
  return N.nodeObject(new RawTextureNode(texture)).setSampler(false);
}
export function uniformBinding(uniforms, name, type) {
  return N.uniform(uniforms[name].value, type).onObjectUpdate(
    () => uniforms[name].value,
  );
}
export function textureBinding(uniforms, name, rawCoordinates = false) {
  const getTexture = () => uniforms[name].value;
  // Accumulator render targets retain Three's backend coordinate conversion.
  const binding = rawCoordinates
    ? uintTexture(getTexture())
    : N.uniformTexture(getTexture()).setSampler(false);
  // Dynamic bindings stay distinct even while they share a texture.
  binding.mergeable = false;
  return binding.onObjectUpdate(getTexture);
}
export function load2D(binding, coord) {
  const texel = binding.load(coord);
  texel.updateMatrix = false;
  return texel;
}
export function loadArray(binding, coord) {
  return binding.load(coord.xy).depth(coord.z);
}
export const splatTexCoord = N.Fn(([index]) => {
  const value = N.uint(index);
  return N.ivec3(
    N.int(value.bitAnd(SPLAT_TEX_WIDTH_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_WIDTH_BITS).bitAnd(SPLAT_TEX_HEIGHT_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_LAYER_BITS)),
  );
}).setLayout({
  name: "gslSplatTexCoord",
  type: "ivec3",
  inputs: [{ name: "index", type: "uint" }],
});
export const quatVec = N.Fn(([quaternion, vector]) => {
  const t = quaternion.xyz.cross(vector).mul(2);
  return vector.add(quaternion.w.mul(t)).add(quaternion.xyz.cross(t));
}).setLayout({
  name: "gslQuatVec",
  type: "vec3",
  inputs: [
    { name: "quaternion", type: "vec4" },
    { name: "vector", type: "vec3" },
  ],
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
}).setLayout({
  name: "gslQuatQuat",
  type: "vec4",
  inputs: [
    { name: "first", type: "vec4" },
    { name: "second", type: "vec4" },
  ],
});
export const decodeCenter = N.Fn(([data]) => {
  return N.uintBitsToFloat(data.xyz);
}).setLayout({
  name: "gslDecodeCenter",
  type: "vec3",
  inputs: [{ name: "data", type: "uvec4" }],
});
export const decodeAlphaShape = N.Fn(([data]) => {
  return N.unpackHalf2x16(data.w);
}).setLayout({
  name: "gslDecodeAlphaShape",
  type: "vec2",
  inputs: [{ name: "data", type: "uvec4" }],
});
export const decodeRgba = N.Fn(([data, alpha]) => {
  return N.vec4(N.unpackHalf2x16(data.x), N.unpackHalf2x16(data.y).x, alpha);
}).setLayout({
  name: "gslDecodeRgba",
  type: "vec4",
  inputs: [
    { name: "data", type: "uvec4" },
    { name: "alpha", type: "float" },
  ],
});
export const decodeLnScales = N.Fn(([data]) => {
  return N.vec3(N.unpackHalf2x16(data.y).y, N.unpackHalf2x16(data.z));
}).setLayout({
  name: "gslDecodeLnScales",
  type: "vec3",
  inputs: [{ name: "data", type: "uvec4" }],
});
