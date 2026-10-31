import { N } from "./shaderUtils.js";

/** Shared 32-byte record: geometry followed by ready-to-draw fragment data. */
export function packProjection(projection, ndc, pixelScale, centerRange) {
  // The axes are orthogonal before the per-component viewport division.
  const axis1 = projection.axis1.mul(pixelScale).toVar();
  const axis2 = projection.axis2.mul(pixelScale).toVar();
  const largest = axis1.abs().max(axis2.abs());
  // Scale only unusually large axes, per splat, to avoid overflowing half
  // without reducing the precision of unrelated splats.
  const exponent = N.int(
    N.floatBitsToUint(largest.x.max(largest.y)).shiftRight(23),
  );
  const scaleCode = N.uint(exponent.sub(141).max(0).add(7).div(8)).toVar();
  // Construct the reciprocal power of two without division.
  const invAxisScale = N.uintBitsToFloat(
    N.uint(127).sub(scaleCode.mul(8)).shiftLeft(23),
  ).toVar();
  const packedAxis = N.packHalf2x16(axis1.mul(invAxisScale)).toVar();
  // Cache the ratio of the existing half-precision lengths once per splat.
  const minorLength = N.unpackHalf2x16(
    N.packHalf2x16(N.vec2(axis2.mul(invAxisScale).length(), 0)),
  ).x;
  const axisRatio = minorLength
    .div(N.unpackHalf2x16(packedAxis).length().max(1e-20))
    .min(65504); // Keep degenerate axes finite when packing to half.
  // A power-of-two float has no mantissa bits. Its high half shares one
  // word with the half-precision axis ratio, without scattering sign bits.
  const ratioScale = N.packHalf2x16(N.vec2(axisRatio, 0)).bitOr(
    scaleCode.mul(8).add(127).shiftLeft(23),
  );
  const first = N.uvec4(
    N.packSnorm2x16(ndc.div(centerRange)),
    N.floatBitsToUint(projection.viewDepth),
    packedAxis,
    ratioScale,
  );
  // The fragment shader already consumes half RGB/kernel power. Pack them
  // once per projected splat instead of unpacking/repacking at every vertex.
  const rgb = projection.rgba.rgb.min(65504);
  const second = N.uvec4(
    N.packHalf2x16(rgb.rg),
    N.packHalf2x16(N.vec2(rgb.b, projection.kernelPower)),
    N.floatBitsToUint(projection.rgba.a),
    N.floatBitsToUint(projection.supportRadiusSquared),
  );
  return { first, second };
}

/** Decode a projected record and expand the current geometry corner. */
export function unpackProjection(
  first,
  second,
  pixelScale,
  centerRange,
  jitter,
  matrix,
) {
  const ndc = N.unpackSnorm2x16(first.x).mul(centerRange).add(jitter);
  const viewZ = N.uintBitsToFloat(first.y).negate();
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
  const axisScale = N.uintBitsToFloat(first.w.bitAnd(N.uint(0xffff0000)));
  const axis1 = N.unpackHalf2x16(first.z).toVar();
  const ratio = N.unpackHalf2x16(first.w.bitAnd(N.uint(0x7fff))).x;
  const axis2 = N.vec2(axis1.y, axis1.x.negate()).mul(ratio);
  const offset = axis1
    .mul(N.positionGeometry.x)
    .add(axis2.mul(N.positionGeometry.y))
    .mul(axisScale.div(pixelScale));
  // The squared radius passes to the fragment stage bit for bit: a wide
  // kernel's low half carries its edge fade.
  const supportRadiusSquared = N.uintBitsToFloat(second.w);
  return {
    clipPosition: N.vec4(ndc.add(offset).mul(clipW), clipZ, clipW),
    packedSplat: second,
    splatUv: N.positionGeometry.xy.mul(supportRadiusSquared.sqrt()),
  };
}
