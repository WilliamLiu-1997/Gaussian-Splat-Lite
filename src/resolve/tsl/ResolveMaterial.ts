import * as THREE from "three";
import type { Node } from "three/webgpu";
import { NodeMaterial } from "three/webgpu";
import { N, load2D } from "../../rendering/tsl/shaderUtils";
import { materialCamera } from "../../rendering/tsl/tslCompat";
import { MOVING_HISTORY_SAMPLES } from "../StochasticHistory";
import type { ResolveState } from "../StochasticResolvePass";

type ResolveOutputNode = ReturnType<typeof N.renderOutput> & {
  getToneMapping(): THREE.ToneMapping;
  setToneMapping(value: THREE.ToneMapping): void;
};

// A layout emits one reusable shader function for all taps and the final
// conversion. Keep its inputs explicit instead of capturing material uniforms.
const convertPremultiplied = N.Fn(
  ([texel, gamma, perceptual]: [Node<"vec4">, Node<"float">, Node<"bool">]) => {
    const alpha = texel.a.clamp(0, 1);
    const color = N.select(alpha.greaterThan(0), texel.rgb, N.vec3(0)).toVar();
    N.If(perceptual.and(alpha.greaterThan(0)), () => {
      color.assign(color.div(alpha).max(0).pow(gamma).mul(alpha));
    });
    return N.vec4(color, alpha);
  },
).setLayout({
  name: "gslConvertPremultiplied",
  type: "vec4",
  inputs: [
    { name: "texel", type: "vec4" },
    { name: "gamma", type: "float" },
    { name: "perceptual", type: "bool" },
  ],
});

export function createNodeResolveMaterial(
  state: ResolveState,
  filterSize: number,
  writeHistory = false,
) {
  const source = N.textureLoad(state.sourceTexture.value).onObjectUpdate(
    () => state.sourceTexture.value,
  );
  const resolve = N.uniform(false, "bool").onObjectUpdate(
    () => state.resolve.value,
  );
  const depth = N.textureLoad(state.sourceDepth.value).onObjectUpdate(
    () => state.sourceDepth.value,
  );
  const historyWeight = N.uniform(0).onObjectUpdate(
    () => state.history.weight.value,
  );
  const historySorted = N.uniform(false, "bool").onObjectUpdate(
    () => state.history.sorted.value,
  );
  const historyReversed = N.uniform(false, "bool").onObjectUpdate(
    () => state.history.reversed.value,
  );
  const historyColor = N.textureLoad(state.history.color.value).onObjectUpdate(
    () => state.history.color.value,
  );
  const historyDepth = N.textureLoad(state.history.depth.value).onObjectUpdate(
    () => state.history.depth.value,
  );
  const historySamples = N.textureLoad(
    state.history.samples.value,
  ).onObjectUpdate(() => state.history.samples.value);
  const reproject = N.uniform(state.history.reproject);
  const depthToView = N.uniform(state.history.depthToView);
  const logDepth = N.uniform(state.history.logDepth);
  const depthProjection = N.uniform(state.history.depthProjection);
  const hardwareDepth = N.Fn(([encoded]: [Node<"float">]) => {
    const depth = encoded.toVar();
    N.If(logDepth.x.greaterThan(0), () => {
      const viewZ = logDepth.y.sub(
        logDepth.x.mul(encoded.mul(logDepth.z).exp2()),
      );
      depth.assign(depthProjection.x.add(depthProjection.y.div(viewZ)));
    });
    return depth;
  });
  const sampleCount = N.property("float", "gslHistorySamples");
  const perceptual = N.uniform(false, "bool").onObjectUpdate(() => {
    const working = THREE.ColorManagement.workingColorSpace;
    return (
      working !== THREE.SRGBColorSpace &&
      THREE.ColorManagement.getTransfer(working) === THREE.SRGBTransfer
    );
  });

  const physicalSource = (texel: Node<"vec4">) =>
    N.vec4(texel.rgb, texel.a.clamp(0, 1));

  const view = N.Fn((builder) => {
    const camera = materialCamera(builder);
    if ((camera as THREE.ArrayCamera).isArrayCamera) {
      return N.uniformArray<"vec4">(state.sourceViews, "vec4").element(
        N.cameraIndex,
      );
    }
    return N.uniform(state.sourceRect, "vec4");
  })();
  const origin = N.Fn((builder) =>
    (materialCamera(builder) as THREE.ArrayCamera).isArrayCamera
      ? N.uniformArray<"vec2">(state.outputOrigins, "vec2").element(
          N.cameraIndex,
        )
      : N.uniform(state.outputOrigin, "vec2"),
  )();
  const sourceCoord = N.ivec2(N.screenCoordinate.xy.sub(origin));
  const sourceRect = N.ivec4(view);
  const load = (coord: Node<"ivec2">) =>
    load2D(
      source,
      sourceRect.xy.add(coord.clamp(N.ivec2(0), sourceRect.zw.sub(1))),
    );
  const reprojectHistory = (
    result: Node<"vec4">,
    neighborhoodMin: Node<"vec4">,
    neighborhoodMax: Node<"vec4">,
    depthSource: Node<"ivec2">,
  ) => {
    const uv = N.vec2(sourceCoord).add(0.5).div(N.vec2(sourceRect.zw));
    const currentDepth = hardwareDepth(
      load2D(depth, sourceRect.xy.add(depthSource)).r,
    );
    const centerDepth = hardwareDepth(
      load2D(depth, sourceRect.xy.add(sourceCoord)).r,
    );
    const foreground = historySorted.and(
      N.select(
        historyReversed,
        centerDepth.greaterThan(currentDepth),
        centerDepth.lessThan(currentDepth),
      ),
    );
    N.If(historyWeight.greaterThan(0).and(foreground.not()), () => {
      const depthUV = N.vec2(depthSource).add(0.5).div(N.vec2(sourceRect.zw));
      const projected = reproject.mul(N.vec4(depthUV, currentDepth, 1)).toVar();
      N.If(projected.w.greaterThan(0), () => {
        const previous = projected.xyz.div(projected.w).toVar();
        previous.xy.addAssign(uv.sub(depthUV));
        N.If(
          N.all(previous.greaterThanEqual(N.vec3(0))).and(
            N.all(previous.lessThanEqual(N.vec3(1))),
          ),
          () => {
            const expected = depthToView.mul(N.vec4(previous, 1)).toVar();
            N.If(expected.w.abs().greaterThan(1e-8), () => {
              const viewZ = expected.z.div(expected.w);
              const position = previous.xy
                .mul(N.vec2(sourceRect.zw))
                .sub(0.5)
                .toVar();
              const base = N.ivec2(position.floor());
              const fraction = position.fract();
              const historySum = N.vec4(0).toVar();
              const validWeight = N.float(0).toVar();
              const sampleSum = N.float(0).toVar();
              // Reject each depth before interpolating history at silhouettes.
              for (let y = 0; y < 2; y += 1) {
                for (let x = 0; x < 2; x += 1) {
                  const coord = base.add(N.ivec2(x, y));
                  const weightX =
                    x === 0 ? N.float(1).sub(fraction.x) : fraction.x;
                  const weightY =
                    y === 0 ? N.float(1).sub(fraction.y) : fraction.y;
                  const tapWeight = weightX.mul(weightY);
                  N.If(
                    tapWeight
                      .greaterThan(0)
                      .and(coord.x.greaterThanEqual(0))
                      .and(coord.y.greaterThanEqual(0))
                      .and(coord.x.lessThan(sourceRect.z))
                      .and(coord.y.lessThan(sourceRect.w)),
                    () => {
                      const tapUv = N.vec2(coord)
                        .add(0.5)
                        .div(N.vec2(sourceRect.zw));
                      const historyCoord = sourceRect.xy.add(coord);
                      const oldDepth = hardwareDepth(
                        load2D(historyDepth, historyCoord).r,
                      );
                      const actual = depthToView
                        .mul(N.vec4(tapUv, oldDepth, 1))
                        .toVar();
                      // Sorted splats may leave background depth in the seed.
                      const disocclusion = N.select(
                        historyReversed,
                        oldDepth.sub(previous.z),
                        previous.z.sub(oldDepth),
                      );
                      const depthMatches = N.select(
                        historySorted,
                        disocclusion.lessThanEqual(0.0005),
                        actual.w
                          .abs()
                          .greaterThan(1e-8)
                          .and(
                            actual.z
                              .div(actual.w)
                              .sub(viewZ)
                              .abs()
                              .lessThan(viewZ.abs().mul(0.02).max(0.01)),
                          ),
                      );
                      N.If(depthMatches, () => {
                        historySum.addAssign(
                          load2D(historyColor, historyCoord).mul(tapWeight),
                        );
                        sampleSum.addAssign(
                          load2D(historySamples, historyCoord).r.mul(tapWeight),
                        );
                        validWeight.addAssign(tapWeight);
                      });
                    },
                  );
                }
              }
              N.If(validWeight.greaterThan(0), () => {
                const previousColor = historySum.div(validWeight);
                const history = previousColor.clamp(
                  neighborhoodMin,
                  neighborhoodMax,
                );
                // Fade small color excursions; reject changes beyond 10% of
                // the local range, with a 0.01 floor for uniform neighborhoods.
                const colorTolerance = neighborhoodMax
                  .sub(neighborhoodMin)
                  .mul(0.1)
                  .max(N.vec4(0.01));
                const colorError = history
                  .sub(previousColor)
                  .abs()
                  .div(colorTolerance)
                  .toVar();
                const colorConfidence = N.float(1)
                  .sub(
                    colorError.r
                      .max(colorError.g)
                      .max(colorError.b.max(colorError.a)),
                  )
                  .max(0);
                N.If(colorConfidence.greaterThan(0), () => {
                  const motion = previous.xy
                    .sub(uv)
                    .mul(N.vec2(sourceRect.zw))
                    .length();
                  const count = sampleSum
                    .div(validWeight)
                    .min(MOVING_HISTORY_SAMPLES - 1)
                    .mul(colorConfidence)
                    .mul(N.float(1).sub(motion.div(64)).max(0));
                  sampleCount.assign(count.add(1));
                  result.assign(N.mix(result, history, count.div(sampleCount)));
                });
              });
            });
          },
        );
      });
    });
  };
  const fragmentNode = N.Fn(() => {
    if (writeHistory)
      sampleCount.assign(N.select(resolve, 1, MOVING_HISTORY_SAMPLES));
    const result = N.vec4(0).toVar();
    const copySource = () => {
      result.assign(physicalSource(load(sourceCoord)));
    };

    N.If(resolve, () => {
      // Odd kernels split into unequal blocks; interpolate between their centers.
      const nearSize = Math.floor(filterSize / 2);
      const centerDistance = filterSize / 2;
      const nearCenter = (nearSize - 1) / 2;
      const u = N.vec2(sourceCoord).sub(nearCenter).div(centerDistance);
      const base = N.ivec2(u.floor().mul(centerDistance).floor());
      const fraction = N.vec2(sourceCoord.sub(base))
        .sub(nearCenter)
        .div(centerDistance);
      const nearWeights = N.vec2(1).sub(fraction).div(nearSize);
      const farWeights = fraction.div(filterSize - nearSize);
      const hasSplat = N.bool(false).toVar();
      const accumulated = N.vec4(0).toVar();
      const neighborhoodMin = N.vec4(1e20).toVar();
      const neighborhoodMax = N.vec4(-1e20).toVar();
      const depthSource = sourceCoord.toVar();
      const closestDepth = N.select(historyReversed, 0, 1).toVar();

      for (let y = 0; y < filterSize; y += 1) {
        const weightY = y < nearSize ? nearWeights.y : farWeights.y;
        for (let x = 0; x < filterSize; x += 1) {
          const weightX = x < nearSize ? nearWeights.x : farWeights.x;
          const weight = weightX.mul(weightY);
          N.If(weight.greaterThan(0), () => {
            const sourceTexel = load(base.add(N.ivec2(x, y)));
            const texel = convertPremultiplied(
              sourceTexel,
              1 / 2.2,
              perceptual,
            );
            hasSplat.assign(hasSplat.or(sourceTexel.a.greaterThan(1)));
            accumulated.addAssign(texel.mul(weight));
            if (writeHistory) {
              const physical = physicalSource(sourceTexel);
              neighborhoodMin.assign(neighborhoodMin.min(physical));
              neighborhoodMax.assign(neighborhoodMax.max(physical));
              N.If(historySorted.and(sourceTexel.a.greaterThan(1)), () => {
                const coord = base
                  .add(N.ivec2(x, y))
                  .clamp(N.ivec2(0), sourceRect.zw.sub(1));
                const z = hardwareDepth(
                  load2D(depth, sourceRect.xy.add(coord)).r,
                );
                N.If(
                  N.select(
                    historyReversed,
                    z.greaterThan(closestDepth),
                    z.lessThan(closestDepth),
                  ),
                  () => {
                    closestDepth.assign(z);
                    depthSource.assign(coord);
                  },
                );
              });
            }
          });
        }
      }

      N.If(hasSplat, () => {
        result.assign(convertPremultiplied(accumulated, 2.2, perceptual));
        if (writeHistory)
          reprojectHistory(
            result,
            neighborhoodMin,
            neighborhoodMax,
            depthSource,
          );
      }).Else(copySource);
    }).Else(copySource);

    const alpha = result.a.clamp(0, 1);
    const straight = N.select(
      alpha.greaterThan(0),
      result.rgb.div(N.select(alpha.greaterThan(0), alpha, 1)),
      N.vec3(0),
    );
    return N.vec4(straight, alpha);
  })();

  const material = new NodeMaterial();
  material.vertexNode = N.vec4(N.positionLocal, 1);
  material.colorNode = fragmentNode;
  material.outputNode = N.renderOutput(
    N.output,
    THREE.NoToneMapping,
    THREE.NoColorSpace,
  );
  if (writeHistory)
    material.outputNode = N.outputStruct(
      N.output,
      N.vec4(sampleCount, 0, 0, 1),
    );
  // NodeMaterial includes this node only when depthTest/depthWrite are enabled.
  material.depthNode = load2D(depth, sourceRect.xy.add(sourceCoord)).r;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.depthFunc = THREE.AlwaysDepth;
  material.transparent = true;
  material.premultipliedAlpha = true;
  material.toneMapped = true;
  return material;
}

export function configureNodeResolveOutput(
  material: NodeMaterial,
  toneMapping: THREE.ToneMapping,
  colorSpace: string,
) {
  const output = material.outputNode as ResolveOutputNode;
  if (
    output.getToneMapping() !== toneMapping ||
    output.outputColorSpace !== colorSpace
  ) {
    output.setToneMapping(toneMapping);
    output.outputColorSpace = colorSpace;
    material.needsUpdate = true;
  }
}
