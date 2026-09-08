import * as TSL from "three/tsl";
import type { Uniforms } from "../uniforms";
import {
  E,
  type TSLNode,
  decodeAlphaShape,
  decodeCenter,
  decodeLnScales,
  decodeQuaternion,
  decodeRgba,
  quatQuat,
  quatVec,
  uniformBinding,
} from "./shaderUtils";

const N = TSL as Record<string, TSLNode>;

export type ProjectionView = {
  projectionMatrix: TSLNode;
  renderToViewQuat: TSLNode;
  renderToViewPos: TSLNode;
  renderToViewScale: TSLNode;
  near: TSLNode;
  far: TSLNode;
  renderSize: TSLNode;
};

type ProjectionInput =
  | { first: TSLNode; second: TSLNode }
  | {
      valid: TSLNode;
      center: TSLNode;
      lnScales: TSLNode;
      quaternion: TSLNode;
      rgba: TSLNode;
      shapeAmount: TSLNode;
    };

export type SplatProjection = {
  valid: TSLNode;
  clipCenter: TSLNode;
  viewDepth: TSLNode;
  /** NDC offsets for each +/-1 quad corner. */
  axis1: TSLNode;
  axis2: TSLNode;
  /** Source color space; the draw stage applies encodeLinear. */
  rgba: TSLNode;
  supportRadius: TSLNode;
  kernelPower: TSLNode;
};

const scaleQuaternionToMatrix = N.Fn(([scale, quaternion]: TSLNode[]) => {
  const x = quaternion.x;
  const y = quaternion.y;
  const z = quaternion.z;
  const w = quaternion.w;
  return N.mat3(
    N.vec3(
      scale.x.mul(N.float(1).sub(y.mul(y).add(z.mul(z)).mul(2))),
      scale.x.mul(x.mul(y).add(w.mul(z)).mul(2)),
      scale.x.mul(x.mul(z).sub(w.mul(y)).mul(2)),
    ),
    N.vec3(
      scale.y.mul(x.mul(y).sub(w.mul(z)).mul(2)),
      scale.y.mul(N.float(1).sub(x.mul(x).add(z.mul(z)).mul(2))),
      scale.y.mul(y.mul(z).add(w.mul(x)).mul(2)),
    ),
    N.vec3(
      scale.z.mul(x.mul(z).add(w.mul(y)).mul(2)),
      scale.z.mul(y.mul(z).sub(w.mul(x)).mul(2)),
      scale.z.mul(N.float(1).sub(x.mul(x).add(y.mul(y)).mul(2))),
    ),
  );
});

const gaussianSupportRadius = N.Fn(
  ([alpha, maximumRadius, minimumAlpha]: TSLNode[]) => {
    const radius = maximumRadius.toVar();
    N.If(minimumAlpha.greaterThan(0), () => {
      radius.assign(
        maximumRadius.min(alpha.div(minimumAlpha).log().mul(2).max(0).sqrt()),
      );
    });
    return radius;
  },
);

const wideSupportRadius = N.Fn(
  ([alpha, power, maximumRadius, minimumAlpha]: TSLNode[]) => {
    const radius = maximumRadius.toVar();
    N.If(minimumAlpha.greaterThan(0), () => {
      // 1 - (1 - x)^power <= power * x for power >= 1.
      radius.assign(
        maximumRadius.min(
          alpha.mul(power).div(minimumAlpha).log().mul(2).max(0).sqrt(),
        ),
      );
    });
    return radius;
  },
);

/** Shared projection for vertex and compute paths. Call inside a TSL Fn. */
export function createProjectionProgram(
  uniforms: Uniforms,
  view: ProjectionView,
) {
  const {
    projectionMatrix,
    renderToViewQuat,
    renderToViewPos,
    renderToViewScale,
    near,
    far,
    renderSize,
  } = view;
  const maxStdDev = uniformBinding(uniforms, "maxStdDev", "float");
  const minPixelRadius = uniformBinding(uniforms, "minPixelRadius", "float");
  const maxPixelRadius = uniformBinding(uniforms, "maxPixelRadius", "float");
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
  const preBlurAmount = uniformBinding(uniforms, "preBlurAmount", "float");
  const blurAmount = uniformBinding(uniforms, "blurAmount", "float");
  const clipXY = uniformBinding(uniforms, "clipXY", "float");
  const focalAdjustment = uniformBinding(uniforms, "focalAdjustment", "float");

  return (source: ProjectionInput, includeColor = true): SplatProjection => {
    // This is a JS-time choice, not a shader branch. WebGL still reads its
    // packed accumulator; native compute consumes transformed float32 values.
    const packed = "first" in source;
    const valid = N.bool(false).toVar();
    const projectedClipCenter = N.vec4(0, 0, 2, 1).toVar();
    const projectedViewDepth = N.float(0).toVar();
    const projectedAxis1 = N.vec2(0).toVar();
    const projectedAxis2 = N.vec2(0).toVar();
    const projectedRgba = N.vec4(0).toVar();
    const projectedSupportRadius = N.float(0).toVar();
    const projectedKernelPower = N.float(0).toVar();
    const alphaShape = packed
      ? decodeAlphaShape(source.first)
      : N.vec2(source.rgba.a, source.shapeAmount).clamp(0, 1);
    const alpha = alphaShape.x.toVar();
    const sourceValid = packed ? N.bool(true) : source.valid;

    const sourceVisible = sourceValid
      .and(alpha.greaterThanEqual(minAlpha))
      .and(alpha.greaterThan(0));
    N.If(sourceVisible, () => {
      const center = packed ? decodeCenter(source.first) : source.center;
      const viewCenter = quatVec(renderToViewQuat, center)
        .mul(renderToViewScale)
        .add(renderToViewPos);
      const clipCenter = N.vec4(0).toVar();
      const centerVisible = N.bool(false).toVar();
      const depthVisible = viewCenter.z
        .lessThan(near.negate())
        .and(viewCenter.z.greaterThan(far.negate()));
      N.If(depthVisible, () => {
        clipCenter.assign(projectionMatrix.mul(N.vec4(viewCenter, 1)));
        const clip = clipCenter.w.mul(clipXY);
        centerVisible.assign(
          clipCenter.x
            .abs()
            .lessThanEqual(clip)
            .and(clipCenter.y.abs().lessThanEqual(clip)),
        );
      });

      N.If(centerVisible, () => {
        const lnScales = packed
          ? decodeLnScales(source.second)
          : source.lnScales;
        const scales = lnScales.exp().mul(renderToViewScale).toVar();
        N.If(N.all(scales.equal(N.vec3(0))).not(), () => {
          const kernelShape = alphaShape.y.min(1).mul(4).add(1);
          const kernelPower = N.float(0).toVar();
          N.If(kernelShape.greaterThan(1), () => {
            kernelPower.assign(
              kernelShape.mul(kernelShape).sub(1).div(E).exp(),
            );
          });
          const maximumSupportRadius = maxStdDev.add(
            kernelShape.sub(1).max(0).mul(0.7),
          );
          const supportRadius = maximumSupportRadius.toVar();

          const viewQuaternion = quatQuat(
            renderToViewQuat,
            // Keep the unit-quaternion constraint without oct/angle quantization.
            packed
              ? decodeQuaternion(source.second.w)
              : source.quaternion.normalize(),
          );
          const rotationScale = scaleQuaternionToMatrix(scales, viewQuaternion);
          const scaledRenderSize = renderSize.mul(focalAdjustment).toVar();
          const focal = scaledRenderSize
            .mul(0.5)
            .mul(
              N.vec2(
                projectionMatrix.element(0).element(0),
                projectionMatrix.element(1).element(1),
              ),
            );
          const j0 = N.vec3(0).toVar();
          const j1 = N.vec3(0).toVar();
          const isOrthographic = projectionMatrix
            .element(2)
            .element(3)
            .equal(0);
          N.If(isOrthographic, () => {
            j0.assign(N.vec3(focal.x, 0, 0));
            j1.assign(N.vec3(0, focal.y, 0));
          }).Else(() => {
            const invZ = N.float(1).div(viewCenter.z);
            const firstJacobian = focal.mul(invZ);
            const secondJacobian = firstJacobian
              .mul(viewCenter.xy)
              .mul(invZ)
              .negate();
            j0.assign(N.vec3(firstJacobian.x, 0, secondJacobian.x));
            j1.assign(N.vec3(0, firstJacobian.y, secondJacobian.y));
          });

          const transposed = rotationScale.transpose();
          const p0 = transposed.mul(j0);
          const p1 = transposed.mul(j1);
          const a = p0.dot(p0).add(preBlurAmount).toVar();
          const b = p0.dot(p1);
          const d = p1.dot(p1).add(preBlurAmount).toVar();
          const detOrig = a.mul(d).sub(b.mul(b)).toVar();
          a.addAssign(blurAmount);
          d.addAssign(blurAmount);
          const det = a.mul(d).sub(b.mul(b)).toVar();
          N.If(det.greaterThan(0), () => {
            alpha.mulAssign(detOrig.div(det).max(0).sqrt());
          }).Else(() => {
            alpha.assign(0);
          });

          const alphaVisible = alpha
            .greaterThanEqual(minAlpha)
            .and(alpha.greaterThan(0));
          N.If(alphaVisible, () => {
            N.If(kernelPower.equal(0), () => {
              supportRadius.assign(
                gaussianSupportRadius(alpha, supportRadius, minAlpha),
              );
            }).Else(() => {
              supportRadius.assign(
                wideSupportRadius(alpha, kernelPower, supportRadius, minAlpha),
              );
            });
            const eigenAverage = a.add(d).mul(0.5).toVar();
            const eigenDelta = N.vec2(a.sub(d).mul(0.5), b).length().toVar();
            const eigen1 = eigenAverage.add(eigenDelta).toVar();
            // Keep a small positive minor axis when subtraction rounds to zero.
            const eigen2 = eigenAverage.sub(eigenDelta).max(1e-4).toVar();
            const eigenVector1 = N.vec2(0).toVar();
            N.If(b.abs().greaterThan(0.001), () => {
              eigenVector1.assign(N.vec2(b, eigen1.sub(a)).normalize());
            }).Else(() => {
              eigenVector1.assign(
                N.select(a.greaterThanEqual(d), N.vec2(1, 0), N.vec2(0, 1)),
              );
            });
            const eigenVector2 = N.vec2(
              eigenVector1.y,
              eigenVector1.x.negate(),
            );
            const supportScale = N.select(
              maximumSupportRadius.greaterThan(0),
              supportRadius.div(maximumSupportRadius),
              0,
            );
            const fullScale1 = maxPixelRadius.min(
              maximumSupportRadius.mul(eigen1.sqrt()),
            );
            const fullScale2 = maxPixelRadius.min(
              maximumSupportRadius.mul(eigen2.sqrt()),
            );
            const scale1 = fullScale1.mul(supportScale);
            const scale2 = fullScale2.mul(supportScale);
            // Preserve the original wide-kernel minimum-size cutoff.
            const cullScale = N.select(kernelPower.equal(0), supportScale, 1);
            // Match the internal projection scale to keep the cutoff in screen pixels.
            const minProjectedRadius = minPixelRadius.mul(focalAdjustment);

            N.If(
              fullScale1
                .mul(cullScale)
                .greaterThanEqual(minProjectedRadius)
                .or(
                  fullScale2
                    .mul(cullScale)
                    .greaterThanEqual(minProjectedRadius),
                ),
              () => {
                projectedClipCenter.assign(clipCenter);
                projectedViewDepth.assign(viewCenter.z.negate());
                projectedAxis1.assign(
                  eigenVector1.mul(scale1).mul(2).div(scaledRenderSize),
                );
                projectedAxis2.assign(
                  eigenVector2.mul(scale2).mul(2).div(scaledRenderSize),
                );
                projectedRgba.assign(
                  N.vec4(
                    includeColor
                      ? (packed
                          ? decodeRgba(source.second, alpha).rgb
                          : source.rgba.rgb
                        ).max(0)
                      : N.vec3(0),
                    alpha,
                  ),
                );
                projectedSupportRadius.assign(supportRadius);
                projectedKernelPower.assign(kernelPower);
                valid.assign(true);
              },
            );
          });
        });
      });
    });

    return {
      valid,
      clipCenter: projectedClipCenter,
      viewDepth: projectedViewDepth,
      axis1: projectedAxis1,
      axis2: projectedAxis2,
      rgba: projectedRgba,
      supportRadius: projectedSupportRadius,
      kernelPower: projectedKernelPower,
    };
  };
}
