import * as THREE from "three";
import * as TSL from "three/tsl";
import { StorageArrayTexture } from "three/webgpu";
import type { SplatProjection } from "../tsl/ProjectionProgram";
import { type TSLNode, loadArray } from "../tsl/shaderUtils";

const N = TSL as Record<string, TSLNode>;
type TextureLimits = {
  maxTextureDimension2D: number;
  maxTextureArrayLayers: number;
};

function makeTexture(channels = 4) {
  const texture = new StorageArrayTexture(1, 1, 1);
  texture.format =
    channels === 2 ? THREE.RGIntegerFormat : THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

// Round near-square caches to rows instead of source-data layers. Power-of-two
// widths keep addressing cheap; balance array layers beyond a single plane.
export function getProjectionCacheSize(count: number, limits: TextureLimits) {
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

const cacheTexCoord = N.Fn(([index, size]: TSLNode[]) => {
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
});

function store(texture: StorageArrayTexture, coord: TSLNode, value: TSLNode) {
  N.storageTexture(texture, coord.xy, value)
    .depth(coord.z)
    .toWriteOnly()
    .toStack();
}

/** Native projected records: compact layout, paired codec and texture ownership. */
export class ProjectionCache {
  // 32 bytes per source slot and eye. RGB retains half precision; alpha,
  // support radius, kernel power and view depth retain their float32 bits.
  readonly textures = [makeTexture(), makeTexture()];
  readonly order = makeTexture(2);
  readonly size = new THREE.Vector4(1, 1, 1, 0);
  private readonly dimensions = N.uniform(this.size, "uvec4").onObjectUpdate(
    () => this.size,
  );

  resize(size: ReturnType<typeof getProjectionCacheSize>) {
    for (const texture of this.textures)
      texture.setSize(size.width, size.height, size.depth);
    this.size.set(size.width, size.height, size.depth, Math.log2(size.width));
  }

  ensureOrder(multiView: boolean, shrink: boolean) {
    if (multiView) {
      this.order.setSize(this.size.x, this.size.y, this.size.z);
    } else if (shrink) {
      this.order.setSize(1, 1, 1);
    }
  }

  storeOrder(index: TSLNode, value: TSLNode) {
    store(this.order, cacheTexCoord(index, this.dimensions), value);
  }

  readOrder(index: TSLNode) {
    return loadArray(
      N.textureLoad(this.order),
      cacheTexCoord(index, this.dimensions),
    );
  }

  // Call after visibility and deferred color evaluation, inside the same guard.
  write(
    index: TSLNode,
    projection: SplatProjection,
    ndc: TSLNode,
    pixelScale: TSLNode,
    centerRange: TSLNode,
  ) {
    const coord = cacheTexCoord(index, this.dimensions).toVar();
    // The axes are orthogonal before the per-component viewport division.
    const axis1 = projection.axis1.mul(pixelScale).toVar();
    const axis2 = projection.axis2.mul(pixelScale).toVar();
    const largest = axis1.abs().max(axis2.abs());
    // Scale only unusually large axes, per splat, so an unlimited radius
    // does not overflow half or reduce the precision of unrelated splats.
    const exponent = N.int(
      N.floatBitsToUint(largest.x.max(largest.y)).shiftRight(23),
    );
    const scaleCode = N.uint(exponent.sub(141).max(0).add(7).div(8)).toVar();
    const axisScale = N.uintBitsToFloat(
      scaleCode.mul(8).add(127).shiftLeft(23),
    );
    const packedAxis = N.packHalf2x16(axis1.div(axisScale));
    // RGB and minor length are nonnegative. Their four unused sign bits
    // hold the shared axis exponent; the float32 fields remain untouched.
    const minorRed = N.packHalf2x16(
      N.vec2(axis2.div(axisScale).length(), projection.rgba.r),
    )
      .bitAnd(N.uint(0x7fff7fff))
      .bitOr(scaleCode.bitAnd(1).shiftLeft(15))
      .bitOr(scaleCode.bitAnd(2).shiftLeft(30));
    const greenBlue = N.packHalf2x16(projection.rgba.gb)
      .bitAnd(N.uint(0x7fff7fff))
      .bitOr(scaleCode.bitAnd(4).shiftLeft(13))
      .bitOr(scaleCode.bitAnd(8).shiftLeft(28));
    store(
      this.textures[0],
      coord,
      N.uvec4(
        N.packSnorm2x16(ndc.div(centerRange)),
        N.floatBitsToUint(projection.viewDepth),
        packedAxis,
        minorRed,
      ),
    );
    store(
      this.textures[1],
      coord,
      N.uvec4(
        greenBlue,
        N.floatBitsToUint(projection.rgba.a),
        N.floatBitsToUint(projection.supportRadius),
        N.floatBitsToUint(projection.kernelPower),
      ),
    );
  }

  // Call inside the per-eye visible-count guard. No cache loads precede it.
  read(index: TSLNode, pixelScale: TSLNode, centerRange: TSLNode) {
    const coord = cacheTexCoord(index, this.dimensions).toVar();
    const first = loadArray(N.textureLoad(this.textures[0]), coord).toVar();
    const second = loadArray(N.textureLoad(this.textures[1]), coord).toVar();
    const ndc = N.unpackSnorm2x16(first.x).mul(centerRange);
    const viewZ = N.uintBitsToFloat(first.y).negate();
    const matrix = N.cameraProjectionMatrix;
    const col0 = matrix.element(0);
    const col1 = matrix.element(1);
    const col2 = matrix.element(2);
    const col3 = matrix.element(3);
    const clipW = col2.w.mul(viewZ).add(col3.w).toVar();
    const clipZ = col2.z.mul(viewZ).add(col3.z).toVar();
    // Standard perspective, orthographic and asymmetric XR projections take
    // the fast path. Oblique/custom depth rows also depend on view X/Y.
    N.If(
      N.any(col0.zw.notEqual(N.vec2(0))).or(N.any(col1.zw.notEqual(N.vec2(0)))),
      () => {
        const a = col0.xy.sub(ndc.mul(col0.w));
        const b = col1.xy.sub(ndc.mul(col1.w));
        const rhs = ndc.mul(clipW).sub(col2.xy.mul(viewZ).add(col3.xy));
        const determinant = a.x.mul(b.y).sub(b.x.mul(a.y));
        const xy = N.vec2(
          rhs.x.mul(b.y).sub(b.x.mul(rhs.y)),
          a.x.mul(rhs.y).sub(rhs.x.mul(a.y)),
        )
          .div(determinant)
          .toVar();
        clipW.addAssign(col0.w.mul(xy.x).add(col1.w.mul(xy.y)));
        clipZ.addAssign(col0.z.mul(xy.x).add(col1.z.mul(xy.y)));
      },
    );
    const scaleCode = first.w
      .shiftRight(15)
      .bitAnd(1)
      .bitOr(first.w.shiftRight(30).bitAnd(2))
      .bitOr(second.x.shiftRight(13).bitAnd(4))
      .bitOr(second.x.shiftRight(28).bitAnd(8));
    const axisScale = N.uintBitsToFloat(
      scaleCode.mul(8).add(127).shiftLeft(23),
    );
    const axis1 = N.unpackHalf2x16(first.z).toVar();
    const minorRed = N.unpackHalf2x16(first.w.bitAnd(N.uint(0x7fff7fff)));
    const greenBlue = N.unpackHalf2x16(second.x.bitAnd(N.uint(0x7fff7fff)));
    const axis2 = N.vec2(axis1.y, axis1.x.negate()).mul(
      minorRed.x.div(axis1.length().max(1e-20)),
    );
    const offset = axis1
      .mul(N.positionGeometry.x)
      .add(axis2.mul(N.positionGeometry.y))
      .mul(axisScale.div(pixelScale));
    const supportRadius = N.uintBitsToFloat(second.z);
    return {
      clipPosition: N.vec4(ndc.add(offset).mul(clipW), clipZ, clipW),
      rgba: N.vec4(minorRed.y, greenBlue, N.uintBitsToFloat(second.y)),
      splatUv: N.positionGeometry.xy.mul(supportRadius),
      supportRadiusSquared: supportRadius.mul(supportRadius),
      kernelPower: N.uintBitsToFloat(second.w),
    };
  }

  dispose() {
    for (const texture of [...this.textures, this.order]) texture.dispose();
  }
}
