import {
  BLIND_ENCODING_SHIFT,
  BLIND_HAS_LOWER,
  BLIND_HAS_UPPER,
} from "../../scene/SplatEditBlind.js";
import { N, loadArray, textureBinding, uniformBinding } from "./shaderUtils.js";

const DISTANCE_LIMIT = 1e20;

export function createBlindSelection(uniforms) {
  const texture = textureBinding(uniforms, "blindTexture", true);
  const stride = uniformBinding(uniforms, "blindStride", "uint");
  const layerBits = uniformBinding(uniforms, "blindLayerBits", "uint");
  const layerMask = uniformBinding(uniforms, "blindLayerMask", "uint");

  return (sourceIndex, field, flags, bounds) => {
    const address = sourceIndex.add(field.x.mul(stride)).toVar();
    const coord = N.ivec3(
      N.int(address.bitAnd(2047)),
      N.int(address.bitAnd(layerMask).shiftRight(11)),
      N.int(address.shiftRight(layerBits)),
    );
    const bits = loadArray(texture, coord)
      .r.shiftRight(field.y)
      .bitAnd(field.z)
      .toVar();
    const encoding = flags.shiftRight(BLIND_ENCODING_SHIFT).bitAnd(3).toVar();
    const lower = N.float(0).toVar();
    const upper = N.float(0).toVar();
    const nonFinite = N.bool(false).toVar();
    N.If(encoding.equal(N.uint(0)), () => {
      const residual = N.uintBitsToFloat(bounds.zw).toVar();
      lower.assign(uintDifference(bounds.x, bits).add(residual.x));
      upper.assign(uintDifference(bits, bounds.y).sub(residual.y));
    }).Else(() => {
      // Test exponent bits: compilers fold float NaN comparisons away.
      const value = N.float(0).toVar();
      N.If(encoding.equal(N.uint(1)), () => {
        nonFinite.assign(bits.bitAnd(0x7c00).equal(N.uint(0x7c00)));
        value.assign(N.unpackHalf2x16(bits).x);
      })
        .ElseIf(encoding.equal(N.uint(2)), () => {
          nonFinite.assign(bits.bitAnd(0x7f800000).equal(N.uint(0x7f800000)));
          value.assign(N.uintBitsToFloat(bits));
        })
        .Else(() => {
          const decode = N.uintBitsToFloat(bounds.zw).toVar();
          value.assign(decode.x.add(decode.y.mul(N.float(bits))));
        });
      const range = N.uintBitsToFloat(bounds.xy).toVar();
      lower.assign(range.x.sub(value));
      upper.assign(value.sub(range.y));
    });
    // Missing bounds are flags, never infinities.
    const distance = N.max(
      N.select(
        flags.bitAnd(BLIND_HAS_LOWER).notEqual(N.uint(0)),
        lower,
        -DISTANCE_LIMIT,
      ),
      N.select(
        flags.bitAnd(BLIND_HAS_UPPER).notEqual(N.uint(0)),
        upper,
        -DISTANCE_LIMIT,
      ),
    ).toVar();
    // Inclusive range endpoints must become exclusive when inverted.
    return N.select(
      nonFinite,
      DISTANCE_LIMIT,
      N.select(
        distance.equal(0),
        -1e-20,
        distance.clamp(-DISTANCE_LIMIT, DISTANCE_LIMIT),
      ),
    );
  };
}

function uintDifference(a, b) {
  return N.select(
    a.greaterThanEqual(b),
    N.float(a.sub(b)),
    N.float(b.sub(a)).negate(),
  );
}
