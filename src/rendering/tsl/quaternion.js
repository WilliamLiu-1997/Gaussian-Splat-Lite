import * as N from "three/tsl";

export const encodeQuatSmallestThree32 = N.Fn(([value]) => {
  const q = value.normalize().toVar();
  const magnitudes = q.abs().toVar();
  const omitted = N.uint(0).toVar();
  const largest = magnitudes.x.toVar();
  for (const [index, component] of ["y", "z", "w"].entries()) {
    N.If(magnitudes[component].greaterThan(largest), () => {
      omitted.assign(index + 1);
      largest.assign(magnitudes[component]);
    });
  }
  N.If(q.element(omitted).lessThan(0), () => {
    q.negateAssign();
  });
  const kept = N.select(
    omitted.equal(N.uint(0)),
    q.yzw,
    N.select(
      omitted.equal(N.uint(1)),
      q.xzw,
      N.select(omitted.equal(N.uint(2)), q.xyw, q.xyz),
    ),
  );
  const scaled = kept.mul(511 * Math.SQRT2).toVar();
  // Nearest integer, ties away from zero; negative fields use two's complement.
  const quantized = N.uvec3(
    N.ivec3(scaled.sign().mul(scaled.abs().add(0.5).floor())),
  ).bitAnd(N.uvec3(0x3ff));
  return omitted
    .shiftLeft(30)
    .bitOr(quantized.z.shiftLeft(20))
    .bitOr(quantized.y.shiftLeft(10))
    .bitOr(quantized.x);
}).setLayout({
  name: "gslEncodeQuatSmallestThree32",
  type: "uint",
  inputs: [{ name: "value", type: "vec4" }],
});

export const decodeQuatSmallestThree32 = N.Fn(([word]) => {
  const omitted = word.shiftRight(30);
  const fields = N.ivec3(
    N.uvec3(word, word.shiftRight(10), word.shiftRight(20)).bitAnd(
      N.uvec3(0x3ff),
    ),
  );
  const kept = N.vec3(fields.bitXor(N.ivec3(0x200)).sub(N.ivec3(0x200)))
    .mul(1 / (511 * Math.SQRT2))
    .toVar();
  const missing = N.float(1).sub(kept.dot(kept)).sqrt().toVar();
  return N.select(
    omitted.equal(N.uint(0)),
    N.vec4(missing, kept),
    N.select(
      omitted.equal(N.uint(1)),
      N.vec4(kept.x, missing, kept.yz),
      N.select(
        omitted.equal(N.uint(2)),
        N.vec4(kept.xy, missing, kept.z),
        N.vec4(kept, missing),
      ),
    ),
  );
}).setLayout({
  name: "gslDecodeQuatSmallestThree32",
  type: "vec4",
  inputs: [{ name: "word", type: "uint" }],
});
