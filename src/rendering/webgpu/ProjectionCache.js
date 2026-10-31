import * as THREE from "three";
import { StorageArrayTexture } from "three/webgpu";
import { packProjection, unpackProjection } from "../tsl/ProjectionCodec.js";
import { N, loadArray, uintTexture } from "../tsl/shaderUtils.js";
function makeTexture() {
  const texture = new StorageArrayTexture(1, 1, 1);
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
// Round near-square caches to rows instead of source-data layers. Power-of-two
// widths keep addressing cheap; balance array layers beyond a single plane.
export function getProjectionCacheSize(count, limits) {
  if (!Number.isSafeInteger(count) || count > 0x1_0000_0000) {
    throw new RangeError("Projected Splat entries exceed uint32 addressing");
  }
  const side = limits.maxTextureDimension2D;
  const maxWidth = 2 ** Math.floor(Math.log2(side));
  const depth = Math.ceil(count / (maxWidth * side));
  if (depth > limits.maxTextureArrayLayers) {
    throw new RangeError(
      "Projected Splat textures exceed the WebGPU device texture limits",
    );
  }
  const perLayer = Math.ceil(count / depth);
  const width = Math.min(
    maxWidth,
    2 ** Math.ceil(Math.log2(Math.ceil(Math.sqrt(perLayer)))),
  );
  const height = Math.ceil(perLayer / width);
  return { width, height, depth };
}
const cacheTexCoord = N.Fn(([index, size]) => {
  const value = N.uint(index);
  const row = value.shiftRight(size.w).toVar();
  const layer = N.uint(0).toVar();
  N.If(size.z.greaterThan(N.uint(1)), () => {
    layer.assign(row.div(size.y));
  });
  // Integer addressing stays exact above 2^24 entries; mono-layer caches need
  // no division. The fourth size component holds log2(width).
  return N.ivec3(
    value.bitAnd(size.x.sub(N.uint(1))),
    row.sub(layer.mul(size.y)),
    layer,
  );
}).setLayout({
  name: "gslCacheTexCoord",
  type: "ivec3",
  inputs: [
    { name: "index", type: "uint" },
    { name: "size", type: "uvec4" },
  ],
});
function store(texture, coord, value) {
  N.storageTexture(texture, coord.xy, value)
    .depth(coord.z)
    .toWriteOnly()
    .toStack();
}
/** Native projected records: compact layout, paired codec and texture ownership. */
export class ProjectionCache {
  constructor() {
    // 32 bytes per compact slot and eye. RGB/kernel power match the fragment
    // varying's half precision; alpha, squared support radius and view depth
    // retain their float32 bits.
    this.textures = [makeTexture(), makeTexture()];
    this.size = new THREE.Vector4(1, 1, 1, 0);
    this.dimensions = N.uniform(this.size, "uvec4");
  }
  resize(size) {
    for (const texture of this.textures)
      texture.setSize(size.width, size.height, size.depth);
    this.size.set(size.width, size.height, size.depth, Math.log2(size.width));
  }
  // Call after visibility and deferred color evaluation, inside the same guard.
  write(index, projection, ndc, pixelScale, centerRange) {
    const coord = cacheTexCoord(index, this.dimensions).toVar();
    const { first, second } = packProjection(
      projection,
      ndc,
      pixelScale,
      centerRange,
    );
    store(this.textures[0], coord, first);
    store(this.textures[1], coord, second);
  }

  /**
   * A shared WebXR slot another eye draws: a transparent record whose
   * corners collapse to one point, behind a perspective camera.
   */
  writeHidden(index) {
    const coord = cacheTexCoord(index, this.dimensions).toVar();
    store(
      this.textures[0],
      coord,
      N.uvec4(0, N.floatBitsToUint(N.float(-1)), 0, 0),
    );
    store(this.textures[1], coord, N.uvec4(0));
  }
  // Call inside the per-eye visible-count guard. No cache loads precede it.
  read(
    index,
    pixelScale,
    centerRange,
    /** NDC translation from the cached projection to the drawn one. */
    jitter,
    /** Projection of the drawn eye. */
    matrix,
  ) {
    const coord = cacheTexCoord(index, this.dimensions).toVar();
    const first = loadArray(uintTexture(this.textures[0]), coord).toVar();
    const second = loadArray(uintTexture(this.textures[1]), coord).toVar();
    return unpackProjection(
      first,
      second,
      pixelScale,
      centerRange,
      jitter,
      matrix,
    );
  }

  dispose() {
    for (const texture of this.textures) texture.dispose();
  }
}
