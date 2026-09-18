import * as THREE from "three";
import type { Node } from "three/webgpu";
import { NodeMaterial } from "three/webgpu";
import {
  HISTORY_SAMPLES,
  HISTORY_TRANSITION_FRAMES,
  MOVING_HISTORY_SAMPLES,
  SPATIAL_SMOOTHING,
  SPATIAL_SMOOTHING_MIN_WEIGHT,
} from "../StochasticHistory";
import type { ResolveState } from "../StochasticResolvePass";
import { N, load2D } from "./shaderUtils";
import { type ResolveOutputNode, materialCamera } from "./tslCompat";

// A layout emits one reusable shader function for all 16 taps and the final
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
  writeHistory = false,
) {
  const source = N.textureLoad(state.sourceTexture.value).onObjectUpdate(
    () => state.sourceTexture.value,
  );
  const splatMask = N.textureLoad(state.splatMask.value).onObjectUpdate(
    () => state.splatMask.value,
  );
  const spatialStrength = N.uniform(1).onObjectUpdate(
    () => state.spatialStrength.value,
  );
  const resolve = N.uniform(false, "bool").onObjectUpdate(
    () => state.resolve.value,
  );
  const resolveDepth = N.uniform(false, "bool").onObjectUpdate(
    () => state.resolveDepth.value,
  );
  const temporal = N.uniform(false, "bool").onObjectUpdate(
    () => state.history.active.value,
  );
  const stationary = N.uniform(false, "bool").onObjectUpdate(
    () => state.history.stationary.value,
  );
  const historyWeight = N.uniform(0).onObjectUpdate(
    () => state.history.weight.value,
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
  const sampleCount = N.property("float", "gslHistorySamples");
  const sampleMarker = N.property("float", "gslHistoryMarker");
  const presentHistory = N.uniform(false, "bool").onObjectUpdate(
    () => state.presentHistory.value,
  );
  const reproject = N.uniform(state.history.reproject);
  const depthToView = N.uniform(state.history.depthToView);
  const depth = N.textureLoad(state.sourceDepth.value).onObjectUpdate(
    () => state.sourceDepth.value,
  );
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
  const fragmentNode = N.Fn(() => {
    const raw = load(sourceCoord).toVar();
    sampleCount.assign(1);
    sampleMarker.assign(N.select(raw.a.equal(2), 2, 0));
    const result = physicalSource(raw).toVar();
    const strength = spatialStrength.toVar();
    N.If(presentHistory.and(stationary), () => {
      // Local recovery fades smoothing by valid samples, not elapsed time.
      const count = load2D(historySamples, sourceCoord).r;
      strength.assign(
        N.mix(
          SPATIAL_SMOOTHING_MIN_WEIGHT,
          1,
          strength.max(
            N.float(1).sub(count.div(HISTORY_TRANSITION_FRAMES)).max(0),
          ),
        ),
      );
    });

    const filterFrame = resolve.or(
      presentHistory
        .and(strength.greaterThan(0))
        .and(N.bool(SPATIAL_SMOOTHING > 0)),
    );
    N.If(filterFrame, () => {
      const u = N.vec2(sourceCoord).sub(0.5).mul(0.5);
      const quad = u.floor();
      const fraction = u.sub(quad);
      const base = N.ivec2(quad).mul(2);
      const nearWeights = N.vec2(1).sub(fraction).mul(0.5);
      const farWeights = fraction.mul(0.5);
      const spatialWeight = (offset: number, axis: "x" | "y") => {
        const tap = base[axis].add(offset);
        const pixel = sourceCoord[axis];
        if (SPATIAL_SMOOTHING === 2) {
          const quadStart = pixel.div(2).mul(2);
          return N.select(
            tap.greaterThanEqual(quadStart).and(tap.lessThan(quadStart.add(2))),
            0.5,
            0,
          );
        }
        if (SPATIAL_SMOOTHING === 3) {
          return N.float(2)
            .sub(N.float(tap.sub(pixel)).abs())
            .max(0)
            .mul(0.25);
        }
        return offset < 2 ? nearWeights[axis] : farWeights[axis];
      };
      // Depth-only coverage has no alpha marker; resolve the final scene color.
      const hasSplat = resolveDepth.toVar();
      const allSplat = N.bool(true).toVar();
      const accumulated = N.vec4(0).toVar();
      const neighborhoodMin = N.vec4(1e20).toVar();
      const neighborhoodMax = N.vec4(-1e20).toVar();
      const depthMin = N.float(1).toVar();
      const depthMax = N.float(0).toVar();
      const previousDepthMin = N.float(1).toVar();
      const previousDepthMax = N.float(0).toVar();

      for (let y = 0; y < 4; y += 1) {
        const weightY = spatialWeight(y, "y");
        for (let x = 0; x < 4; x += 1) {
          const weightX = spatialWeight(x, "x");
          const weight = weightX.mul(weightY);
          const coord = base
            .add(N.ivec2(x, y))
            .clamp(N.ivec2(0), sourceRect.zw.sub(1));
          const sourceTexel = load2D(source, sourceRect.xy.add(coord)).toVar();
          const texel = convertPremultiplied(sourceTexel, 1 / 2.2, perceptual);
          // Keep the full neighborhood for coverage detection and history clipping.
          const marker = sourceTexel.a.toVar();
          N.If(presentHistory, () => {
            marker.assign(load2D(splatMask, sourceRect.xy.add(coord)).a);
          });
          hasSplat.assign(hasSplat.or(marker.greaterThan(1)));
          allSplat.assign(allSplat.and(sourceTexel.a.equal(2)));
          if (SPATIAL_SMOOTHING) accumulated.addAssign(texel.mul(weight));
          N.If(temporal, () => {
            const physical = physicalSource(sourceTexel);
            neighborhoodMin.assign(neighborhoodMin.min(physical));
            neighborhoodMax.assign(neighborhoodMax.max(physical));
            N.If(stationary, () => {
              const tapDepth = load2D(depth, coord).r;
              const previousDepth = load2D(historyDepth, coord).r;
              depthMin.assign(depthMin.min(tapDepth));
              depthMax.assign(depthMax.max(tapDepth));
              previousDepthMin.assign(previousDepthMin.min(previousDepth));
              previousDepthMax.assign(previousDepthMax.max(previousDepth));
            });
          });
        }
      }

      N.If(hasSplat, () => {
        if (SPATIAL_SMOOTHING) {
          // Accumulate raw stationary samples, while still validating history.
          N.If(temporal.and(stationary).not(), () => {
            // Moving-frame filtering can mix ordinary pixels into a Splat.
            sampleMarker.assign(N.select(allSplat, 2, 0));
            result.assign(
              N.mix(
                result,
                convertPremultiplied(accumulated, 2.2, perceptual),
                strength,
              ),
            );
          });
        }
        N.If(temporal.and(historyWeight.greaterThan(0)), () => {
          const uv = N.vec2(sourceCoord).add(0.5).div(N.vec2(sourceRect.zw));
          const currentDepth = load2D(depth, sourceCoord).r;
          const projected = N.select(
            stationary,
            N.vec4(uv, currentDepth, 1),
            reproject.mul(N.vec4(uv, currentDepth, 1)),
          ).toVar();
          N.If(projected.w.greaterThan(0), () => {
            const previous = projected.xyz.div(projected.w).toVar();
            N.If(
              N.all(previous.greaterThanEqual(N.vec3(0))).and(
                N.all(previous.lessThanEqual(N.vec3(1))),
              ),
              () => {
                const expected = depthToView.mul(N.vec4(previous, 1)).toVar();
                N.If(stationary.or(expected.w.abs().greaterThan(1e-8)), () => {
                  const viewZ = expected.z.div(expected.w);
                  const position = previous.xy
                    .mul(N.vec2(sourceRect.zw))
                    .sub(0.5)
                    .toVar();
                  // Avoid bilinear rounding/blur for an unchanged camera.
                  const historyBase = N.select(
                    stationary,
                    sourceCoord,
                    N.ivec2(position.floor()),
                  );
                  const fraction = N.select(
                    stationary,
                    N.vec2(0),
                    position.fract(),
                  );
                  const historySum = N.vec4(0).toVar();
                  const validWeight = N.float(0).toVar();
                  const sampleSum = N.float(0).toVar();
                  const historyIsSplat = N.bool(true).toVar();
                  // Reject individual depths before interpolating history.
                  for (let y = 0; y < 2; y += 1) {
                    for (let x = 0; x < 2; x += 1) {
                      const coord = historyBase.add(N.ivec2(x, y));
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
                          const oldDepth = load2D(historyDepth, coord).r;
                          const actual = depthToView
                            .mul(N.vec4(tapUv, oldDepth, 1))
                            .toVar();
                          N.If(
                            stationary.or(actual.w.abs().greaterThan(1e-8)),
                            () => {
                              N.If(
                                // Stationary stochastic samples can switch surfaces.
                                N.select(
                                  stationary,
                                  depthMin
                                    .lessThanEqual(previousDepthMax)
                                    .and(
                                      previousDepthMin.lessThanEqual(depthMax),
                                    ),
                                  actual.z
                                    .div(actual.w)
                                    .sub(viewZ)
                                    .abs()
                                    .lessThan(viewZ.abs().mul(0.02).max(0.01)),
                                ),
                                () => {
                                  const historyTap = load2D(
                                    historyColor,
                                    coord,
                                  ).toVar();
                                  historySum.addAssign(
                                    historyTap.mul(tapWeight),
                                  );
                                  validWeight.addAssign(tapWeight);
                                  const historyInfo = load2D(
                                    historySamples,
                                    coord,
                                  );
                                  historyIsSplat.assign(
                                    historyIsSplat.and(historyInfo.g.equal(2)),
                                  );
                                  sampleSum.addAssign(
                                    historyInfo.r.mul(tapWeight),
                                  );
                                },
                              );
                            },
                          );
                        },
                      );
                    }
                  }
                  N.If(validWeight.greaterThan(0), () => {
                    const previousColor = historySum.div(validWeight);
                    // Random coverage can vary pure Splat colors. Mixed history
                    // must keep clipping and updating until it is discarded.
                    const pureSplatHistory = stationary
                      .and(sampleMarker.equal(2))
                      .and(historyIsSplat);
                    const history = N.select(
                      pureSplatHistory,
                      previousColor,
                      previousColor.clamp(neighborhoodMin, neighborhoodMax),
                    );
                    const motion = N.select(
                      stationary,
                      0,
                      previous.xy.sub(uv).mul(N.vec2(sourceRect.zw)).length(),
                    );
                    const limit = N.select(
                      stationary,
                      HISTORY_SAMPLES,
                      MOVING_HISTORY_SAMPLES,
                    );
                    const count = sampleSum
                      .div(validWeight)
                      .min(N.select(pureSplatHistory, limit, limit.sub(1)))
                      .mul(N.float(1).sub(motion.div(64)).max(0))
                      .toVar();
                    // Transparent changes can reject color without changing depth.
                    N.If(
                      N.any(
                        history
                          .sub(previousColor)
                          .abs()
                          .greaterThan(N.vec4(1e-4)),
                      ),
                      () => {
                        count.assign(0);
                      },
                    );
                    // Track the entire accumulated color, not just the last frame.
                    N.If(count.greaterThan(0).and(historyIsSplat.not()), () => {
                      sampleMarker.assign(0);
                    });
                    sampleCount.assign(count.add(1).min(limit));
                    result.assign(
                      N.mix(result, history, count.div(sampleCount)),
                    );
                  });
                });
              },
            );
          });
        });
      });
    });
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
      N.vec4(sampleCount, sampleMarker, 0, 1),
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
