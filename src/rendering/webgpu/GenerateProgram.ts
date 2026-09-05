import * as TSL from "three/tsl";
import type { Uniforms } from "../uniforms";
import type { TSLNode } from "./shaderUtils";
import {
  E,
  decodeAlphaShape,
  decodeCenter,
  decodeLnScales,
  decodeQuaternion,
  decodeRgba,
  load2D,
  loadArray,
  quatQuat,
  quatVec,
  splatTexCoord,
  textureBinding,
  uniformBinding,
} from "./shaderUtils";

const N = TSL as Record<string, TSLNode>;

const MAX_SEMANTIC_OPACITY = 1000;

// WGSL rejects non-finite constant expressions, so keep infinity in a runtime
// uniform for SDF reductions and deleted-splat handling.
const FLOAT_INFINITY = N.uniform(Number.POSITIVE_INFINITY, "float");

const encodeQuaternion = N.Fn(([input]: TSLNode[]) => {
  const quaternion = N.select(input.w.lessThan(0), input.negate(), input);
  const theta = quaternion.w.clamp(0, 1).acos().mul(2);
  const sum = quaternion.x
    .abs()
    .add(quaternion.y.abs())
    .add(quaternion.z.abs());
  const projected = N.select(
    sum.lessThan(1e-6),
    N.vec2(1, 0),
    quaternion.xy.div(sum),
  ).toVar();
  N.If(quaternion.z.lessThan(0), () => {
    const oldX = projected.x.toVar();
    projected.x.assign(
      N.float(1)
        .sub(projected.y.abs())
        .mul(N.select(projected.x.greaterThanEqual(0), 1, -1)),
    );
    projected.y.assign(
      N.float(1)
        .sub(oldX.abs())
        .mul(N.select(projected.y.greaterThanEqual(0), 1, -1)),
    );
  });

  const quantized = projected
    .mul(0.5)
    .add(0.5)
    .mul(1023)
    .round()
    .clamp(0, 1023);
  const quantU = N.uint(quantized.x);
  const quantV = N.uint(quantized.y);
  const angle = N.uint(theta.div(Math.PI).mul(4095).round().clamp(0, 4095));
  return angle.shiftLeft(20).bitOr(quantV.shiftLeft(10)).bitOr(quantU);
});

const decodeShRgb = N.Fn(([encoded]: TSLNode[]) => {
  const biasedBase = encoded.shiftRight(27).bitAnd(0x1f);
  const divisor = N.uintBitsToFloat(biasedBase.add(112).shiftLeft(23)).div(255);
  const rgb = N.vec3(
    N.float(encoded.bitAnd(0xff)),
    N.float(encoded.shiftRight(8).bitAnd(0xff)),
    N.float(encoded.shiftRight(16).bitAnd(0xff)),
  )
    .mul(divisor)
    .toVar();
  return N.vec3(
    N.select(
      encoded.bitAnd(0x1000000).notEqual(N.uint(0)),
      rgb.x.negate(),
      rgb.x,
    ),
    N.select(
      encoded.bitAnd(0x2000000).notEqual(N.uint(0)),
      rgb.y.negate(),
      rgb.y,
    ),
    N.select(
      encoded.bitAnd(0x4000000).notEqual(N.uint(0)),
      rgb.z.negate(),
      rgb.z,
    ),
  );
});

const decodeSemanticOpacity = N.Fn(([alpha, shapeAmount]: TSLNode[]) => {
  const result = alpha.toVar();
  N.If(shapeAmount.greaterThan(0), () => {
    const kernelShape = shapeAmount.mul(4).add(1);
    const kernelOpacity = kernelShape.mul(kernelShape).sub(1).div(E).exp();
    result.assign(alpha.mul(kernelOpacity).min(MAX_SEMANTIC_OPACITY));
  });
  return result;
});

const encodeWideSemanticOpacity = N.Fn(([opacity]: TSLNode[]) => {
  return opacity
    .min(MAX_SEMANTIC_OPACITY)
    .log()
    .mul(E)
    .add(1)
    .sqrt()
    .sub(1)
    .mul(0.25);
});

export function createGenerateProgram({ uniforms }: { uniforms: Uniforms }) {
  const bindUniform = (name: string, type?: string) =>
    uniformBinding(uniforms, name, type);
  const bindTexture = (name: string, array = false) =>
    textureBinding(uniforms, name, array);

  const targetCount = bindUniform("targetCount", "uint");
  const sourceSplats = bindTexture("sourceSplats", true);
  const sourceSplats2 = bindTexture("sourceSplats2", true);
  const numSh = bindUniform("numSh", "int");
  const sh1Texture = bindTexture("sh1Texture", true);
  const sh2Texture = bindTexture("sh2Texture", true);
  const sh3TextureA = bindTexture("sh3TextureA", true);
  const sh3TextureB = bindTexture("sh3TextureB", true);
  const objectBasis = bindUniform("objectBasis", "mat3");
  const objectOffset = bindUniform("objectOffset", "vec3");
  const objectLnScale = bindUniform("objectLnScale", "vec3");
  const objectQuaternion = bindUniform("objectQuaternion", "vec4");
  const recolor = bindUniform("recolor", "vec4");
  const numSdfs = bindUniform("numSdfs", "int");
  const numEdits = bindUniform("numEdits", "int");
  const sdfTexture = bindTexture("sdfTexture");
  const editTexture = bindTexture("editTexture");

  const evaluateSH1 = N.Fn(([data, direction]: TSLNode[]) => {
    return decodeShRgb(data.x)
      .mul(direction.y.mul(-0.4886025))
      .add(decodeShRgb(data.y).mul(direction.z.mul(0.4886025)))
      .add(decodeShRgb(data.z).mul(direction.x.mul(-0.4886025)));
  });

  const evaluateSH12 = N.Fn(([first, second, direction]: TSLNode[]) => {
    const result = evaluateSH1(first, direction).toVar();
    result.addAssign(
      decodeShRgb(first.w).mul(direction.x.mul(direction.y).mul(1.0925484)),
    );
    result.addAssign(
      decodeShRgb(second.x).mul(direction.y.mul(direction.z).mul(-1.0925484)),
    );
    result.addAssign(
      decodeShRgb(second.y).mul(
        direction.z
          .mul(direction.z)
          .mul(2)
          .sub(direction.x.mul(direction.x))
          .sub(direction.y.mul(direction.y))
          .mul(0.3153915),
      ),
    );
    result.addAssign(
      decodeShRgb(second.z).mul(direction.x.mul(direction.z).mul(-1.0925484)),
    );
    result.addAssign(
      decodeShRgb(second.w).mul(
        direction.x
          .mul(direction.x)
          .sub(direction.y.mul(direction.y))
          .mul(0.5462742),
      ),
    );
    return result;
  });

  const evaluateSH3 = N.Fn(([first, second, direction]: TSLNode[]) => {
    const xx = direction.x.mul(direction.x);
    const yy = direction.y.mul(direction.y);
    const zz = direction.z.mul(direction.z);
    return decodeShRgb(first.x)
      .mul(direction.y.mul(xx.mul(3).sub(yy)).mul(-0.5900436))
      .add(
        decodeShRgb(first.y).mul(
          direction.x.mul(direction.y).mul(direction.z).mul(2.8906114),
        ),
      )
      .add(
        decodeShRgb(first.z).mul(
          direction.y.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458),
        ),
      )
      .add(
        decodeShRgb(first.w).mul(
          direction.z
            .mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3)))
            .mul(0.3731763),
        ),
      )
      .add(
        decodeShRgb(second.x).mul(
          direction.x.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458),
        ),
      )
      .add(
        decodeShRgb(second.y).mul(direction.z.mul(xx.sub(yy)).mul(1.4453057)),
      )
      .add(
        decodeShRgb(second.z).mul(
          direction.x.mul(xx.sub(yy.mul(3))).mul(-0.5900436),
        ),
      );
  });

  const evaluateSH = N.Fn(([coord, direction]: TSLNode[]) => {
    const result = N.vec3(0).toVar();
    N.If(numSh.equal(N.int(1)), () => {
      result.assign(evaluateSH1(loadArray(sh1Texture, coord), direction));
    }).ElseIf(numSh.greaterThanEqual(N.int(2)), () => {
      result.assign(
        evaluateSH12(
          loadArray(sh1Texture, coord),
          loadArray(sh2Texture, coord),
          direction,
        ),
      );
      N.If(numSh.greaterThanEqual(N.int(3)), () => {
        result.addAssign(
          evaluateSH3(
            loadArray(sh3TextureA, coord),
            loadArray(sh3TextureB, coord),
            direction,
          ),
        );
      });
    });
    return result;
  });

  const generateValues = (index: TSLNode) => {
    const valid = N.bool(false).toVar();
    const center = N.vec3(0).toVar();
    const lnScales = N.vec3(0).toVar();
    const quaternion = N.vec4(0, 0, 0, 1).toVar();
    const rgba = N.vec4(0).toVar();
    const shapeAmount = N.float(0).toVar();

    N.If(index.lessThan(targetCount), () => {
      const coord = splatTexCoord(index);
      const sourceA = loadArray(sourceSplats, coord);
      const sourceB = loadArray(sourceSplats2, coord);
      const sourceLnScales = decodeLnScales(sourceB);

      const isDeleted = N.all(
        sourceLnScales.equal(N.vec3(FLOAT_INFINITY.negate())),
      );
      N.If(isDeleted.not(), () => {
        const alphaShape = decodeAlphaShape(sourceA);
        valid.assign(true);
        center.assign(objectBasis.mul(decodeCenter(sourceA)));
        lnScales.assign(sourceLnScales.add(objectLnScale));
        quaternion.assign(
          quatQuat(objectQuaternion, decodeQuaternion(sourceB.w)),
        );
        rgba.assign(decodeRgba(sourceB, alphaShape.x));
        shapeAmount.assign(alphaShape.y);

        N.If(numSh.greaterThan(N.int(0)), () => {
          const inverseObjectQuaternion = N.vec4(
            objectQuaternion.xyz.negate(),
            objectQuaternion.w,
          );
          const sourceViewDirection = quatVec(
            inverseObjectQuaternion,
            center.add(objectOffset),
          ).normalize();
          rgba.rgb.addAssign(evaluateSH(coord, sourceViewDirection));
        });

        const editPosition = center.toVar();
        center.addAssign(objectOffset);
        const semanticOpacityDecoded = N.bool(false).toVar();

        N.Loop(
          { start: N.int(0), end: numEdits, type: "int", condition: "<" },
          ({ i: editIndex }: { i: TSLNode }) => {
            const edit = load2D(editTexture, N.ivec2(N.int(0), editIndex));
            const blendMode = edit.x.bitAnd(0xff);
            const invert = edit.x.bitAnd(0x100).notEqual(N.uint(0));
            const sdfFirst = N.int(edit.y.bitAnd(0xffff));
            const sdfCount = N.int(edit.y.shiftRight(16));
            const softEdge = N.uintBitsToFloat(edit.z);
            const smoothAmount = N.uintBitsToFloat(edit.w);
            const distanceAccum = N.select(
              smoothAmount.equal(0),
              FLOAT_INFINITY,
              0,
            ).toVar();
            const maxExponent = FLOAT_INFINITY.negate().toVar();
            const sdfRgba = N.vec4(0).toVar();
            const sdfRgbaMask = N.vec4(0).toVar();
            const sdfLast = sdfFirst.add(sdfCount).min(numSdfs);

            N.Loop(
              {
                start: sdfFirst,
                end: sdfLast,
                type: "int",
                condition: "<",
                name: "sdfIndex",
              },
              ({ sdfIndex }: { sdfIndex: TSLNode }) => {
                const data0 = load2D(
                  sdfTexture,
                  N.ivec2(N.int(0), sdfIndex),
                ).toVar();
                const data1 = load2D(
                  sdfTexture,
                  N.ivec2(N.int(1), sdfIndex),
                ).toVar();
                const data2 = load2D(
                  sdfTexture,
                  N.ivec2(N.int(2), sdfIndex),
                ).toVar();
                const data3 = load2D(
                  sdfTexture,
                  N.ivec2(N.int(3), sdfIndex),
                ).toVar();
                const data4 = load2D(
                  sdfTexture,
                  N.ivec2(N.int(4), sdfIndex),
                ).toVar();
                const flags = data0.w;
                const sdfCenter = N.uintBitsToFloat(data0.xyz);
                const sdfQuaternion = N.uintBitsToFloat(data1);
                const sdfScale = N.uintBitsToFloat(data2.xyz);
                const sizes = N.uintBitsToFloat(data3);
                const value = N.uintBitsToFloat(data4);
                const valueMask = N.vec4(
                  N.select(flags.bitAnd(0x10000).notEqual(N.uint(0)), 1, 0),
                  N.select(flags.bitAnd(0x20000).notEqual(N.uint(0)), 1, 0),
                  N.select(flags.bitAnd(0x40000).notEqual(N.uint(0)), 1, 0),
                  N.select(flags.bitAnd(0x80000).notEqual(N.uint(0)), 1, 0),
                );
                const sdfPosition = quatVec(
                  sdfQuaternion,
                  editPosition.mul(sdfScale),
                )
                  .add(sdfCenter)
                  .toVar();
                const sdfType = flags.bitAnd(0xff);
                const distance = FLOAT_INFINITY.toVar();

                N.If(sdfType.equal(N.uint(0)), () => {
                  distance.assign(FLOAT_INFINITY.negate());
                })
                  .ElseIf(sdfType.equal(N.uint(1)), () => {
                    distance.assign(sdfPosition.z);
                  })
                  .ElseIf(sdfType.equal(N.uint(2)), () => {
                    distance.assign(sdfPosition.length().sub(sizes.w));
                  })
                  .ElseIf(sdfType.equal(N.uint(3)), () => {
                    const q = sdfPosition.abs().sub(sizes.xyz).add(sizes.w);
                    distance.assign(
                      q
                        .max(0)
                        .length()
                        .add(q.x.max(q.y.max(q.z)).min(0))
                        .sub(sizes.w),
                    );
                  })
                  .ElseIf(sdfType.equal(N.uint(4)), () => {
                    const k0 = sdfPosition.div(sizes.xyz).length();
                    const k1 = sdfPosition
                      .div(sizes.xyz.dot(sizes.xyz))
                      .length();
                    distance.assign(k0.mul(k0.sub(1)).div(k1));
                  })
                  .ElseIf(sdfType.equal(N.uint(5)), () => {
                    const d = N.vec2(sdfPosition.xz.length(), sdfPosition.y)
                      .abs()
                      .sub(sizes.wy);
                    distance.assign(d.x.max(d.y).min(0).add(d.max(0).length()));
                  })
                  .ElseIf(sdfType.equal(N.uint(6)), () => {
                    sdfPosition.y.subAssign(
                      sdfPosition.y.clamp(sizes.y.mul(-0.5), sizes.y.mul(0.5)),
                    );
                    distance.assign(sdfPosition.length().sub(sizes.w));
                  })
                  .ElseIf(sdfType.equal(N.uint(7)), () => {
                    const angle = sizes.w.mul(Math.PI * 0.25);
                    const c = N.vec2(angle.sin(), angle.cos());
                    const q = N.vec2(
                      sdfPosition.xy.length(),
                      sdfPosition.z.negate(),
                    );
                    const sign = N.select(
                      q.x.mul(c.y).sub(q.y.mul(c.x)).lessThan(0),
                      -1,
                      1,
                    );
                    distance.assign(
                      q
                        .sub(c.mul(q.dot(c).max(0)))
                        .length()
                        .mul(sign),
                    );
                  });

                N.If(flags.bitAnd(0x100).notEqual(N.uint(0)), () => {
                  distance.negateAssign();
                });

                N.If(smoothAmount.equal(0), () => {
                  N.If(distance.lessThan(distanceAccum), () => {
                    distanceAccum.assign(distance);
                    sdfRgba.assign(value.mul(valueMask));
                    sdfRgbaMask.assign(valueMask);
                  });
                }).Else(() => {
                  const exponent = distance.negate().div(smoothAmount);
                  N.If(exponent.greaterThan(maxExponent), () => {
                    const rescale = maxExponent.sub(exponent).exp();
                    distanceAccum.mulAssign(rescale);
                    sdfRgba.mulAssign(rescale);
                    sdfRgbaMask.mulAssign(rescale);
                    maxExponent.assign(exponent);
                  });
                  const weight = exponent.sub(maxExponent).exp();
                  distanceAccum.addAssign(weight);
                  sdfRgba.addAssign(weight.mul(value).mul(valueMask));
                  sdfRgbaMask.addAssign(weight.mul(valueMask));
                });
              },
            );

            const distance = distanceAccum.toVar();
            N.If(smoothAmount.notEqual(0), () => {
              N.If(distanceAccum.equal(0), () => {
                distance.assign(FLOAT_INFINITY);
              }).Else(() => {
                sdfRgba.divAssign(distanceAccum);
                sdfRgbaMask.divAssign(distanceAccum);
                distance.assign(
                  distanceAccum
                    .log()
                    .negate()
                    .sub(maxExponent)
                    .mul(smoothAmount),
                );
              });
            });
            N.If(invert, () => {
              distance.negateAssign();
            });
            const amount = N.select(
              softEdge.equal(0),
              N.select(distance.lessThan(0), 1, 0),
              distance.negate().div(softEdge).add(0.5).clamp(0, 1),
            );
            const editOpacity = amount
              .greaterThan(0)
              .and(sdfRgbaMask.a.greaterThan(0));
            N.If(editOpacity.and(semanticOpacityDecoded.not()), () => {
              rgba.a.assign(
                decodeSemanticOpacity(rgba.a.clamp(0, 1), shapeAmount),
              );
              semanticOpacityDecoded.assign(true);
            });

            const target = rgba.toVar();
            N.If(blendMode.equal(N.uint(0)), () => {
              target.assign(rgba.mul(N.vec4(1).add(sdfRgba).sub(sdfRgbaMask)));
            })
              .ElseIf(blendMode.equal(N.uint(1)), () => {
                target.assign(
                  rgba.mul(N.vec4(1).sub(sdfRgbaMask)).add(sdfRgba),
                );
              })
              .ElseIf(blendMode.equal(N.uint(2)), () => {
                target.assign(rgba.add(sdfRgba));
              });
            rgba.assign(N.mix(rgba, target, amount));
          },
        );

        rgba.rgb.mulAssign(recolor.rgb);
        const opacityScale = recolor.a;
        N.If(
          semanticOpacityDecoded.not().and(opacityScale.greaterThanEqual(1)),
          () => {
            rgba.a.assign(rgba.a.clamp(0, 1));
          },
        ).Else(() => {
          N.If(semanticOpacityDecoded.not(), () => {
            rgba.a.assign(
              decodeSemanticOpacity(rgba.a.clamp(0, 1), shapeAmount),
            );
          });
          const semanticOpacity = rgba.a.mul(opacityScale);
          N.If(semanticOpacity.lessThanEqual(1), () => {
            rgba.a.assign(semanticOpacity.clamp(0, 1));
            shapeAmount.assign(0);
          }).Else(() => {
            rgba.a.assign(1);
            shapeAmount.assign(encodeWideSemanticOpacity(semanticOpacity));
          });
        });
      });
    });

    return { valid, center, lnScales, quaternion, rgba, shapeAmount };
  };

  const generateAccumulator = (index: TSLNode) => {
    const generated = generateValues(index);
    const accumulatorA = N.uvec4(0).toVar();
    const accumulatorB = N.uvec4(0).toVar();

    N.If(generated.valid, () => {
      accumulatorA.assign(
        N.uvec4(
          N.floatBitsToUint(generated.center),
          N.packHalf2x16(
            N.vec2(generated.rgba.a, generated.shapeAmount).clamp(0, 1),
          ),
        ),
      );
      accumulatorB.assign(
        N.uvec4(
          N.packHalf2x16(generated.rgba.rg),
          N.packHalf2x16(N.vec2(generated.rgba.b, generated.lnScales.x)),
          N.packHalf2x16(generated.lnScales.yz),
          encodeQuaternion(generated.quaternion),
        ),
      );
    });

    return { accumulatorA, accumulatorB };
  };

  return generateAccumulator;
}
