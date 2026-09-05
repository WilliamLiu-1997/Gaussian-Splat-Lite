import * as THREE from "three";
import * as TSL from "three/tsl";
import { NodeMaterial, StorageBufferAttribute } from "three/webgpu";
import type { Uniforms } from "../uniforms";
import {
  E,
  type TSLNode,
  decodeAlphaShape,
  decodeCenter,
  decodeLnScales,
  decodeQuaternion,
  decodeRgba,
  loadArray,
  quatQuat,
  quatVec,
  splatTexCoord,
  textureBinding,
  uniformBinding,
} from "./shaderUtils";

export type WebGPUSplatMaterial = NodeMaterial & {
  uniforms: Uniforms;
  orderingNode: TSLNode;
};

const N = TSL as Record<string, TSLNode>;

function splatViewUniforms(uniforms: Uniforms, camera: THREE.Camera) {
  const arrayCamera = camera as THREE.ArrayCamera;
  if (!arrayCamera.isArrayCamera || arrayCamera.cameras.length === 0) {
    return {
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      viewportOrigin: uniformBinding(uniforms, "viewportOrigin", "vec2"),
      renderToViewQuat: uniformBinding(uniforms, "renderToViewQuat", "vec4"),
      renderToViewPos: uniformBinding(uniforms, "renderToViewPos", "vec3"),
      renderToViewScale: uniformBinding(uniforms, "renderToViewScale", "float"),
      near: uniformBinding(uniforms, "near", "float"),
      far: uniformBinding(uniforms, "far", "float"),
    };
  }

  // ArrayCamera draws do not call onBeforeRender separately for each eye.
  // Pack rotation, position/scale, viewport/clipping and pixel origin per eye.
  const views = arrayCamera.cameras.flatMap(() => [
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
    new THREE.Vector4(),
  ]);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const viewData = N.uniformArray(views, "vec4").onObjectUpdate(
    ({ camera }: { camera: THREE.ArrayCamera }) => {
      camera.cameras.forEach((eye, i) => {
        // Subtract the world origin in CPU double precision before GPU upload.
        matrix.makeTranslation(uniforms.renderOrigin.value);
        matrix.premultiply(eye.matrixWorldInverse);
        matrix.decompose(position, rotation, scale);
        views[i * 4].set(rotation.x, rotation.y, rotation.z, rotation.w);
        views[i * 4 + 1].set(
          position.x,
          position.y,
          position.z,
          (scale.x + scale.y + scale.z) / 3,
        );
        const size = uniforms.renderSize.value;
        views[i * 4 + 2].set(
          eye.viewport?.z ?? size.x,
          eye.viewport?.w ?? size.y,
          eye.near,
          eye.far,
        );
        views[i * 4 + 3].set(eye.viewport?.x ?? 0, eye.viewport?.y ?? 0, 0, 0);
      });
    },
  );
  const index = (camera as THREE.ArrayCamera & { isMultiViewCamera?: boolean })
    .isMultiViewCamera
    ? N.builtin("gl_ViewID_OVR")
    : N.cameraIndex;
  const offset = index.mul(4);
  const positionScale = viewData.element(offset.add(1));
  const viewportClip = viewData.element(offset.add(2));
  return {
    renderSize: viewportClip.xy,
    viewportOrigin: viewData.element(offset.add(3)).xy,
    renderToViewQuat: viewData.element(offset),
    renderToViewPos: positionScale.xyz,
    renderToViewScale: positionScale.w,
    near: viewportClip.z,
    far: viewportClip.w,
  };
}

function createDefaultOrderingNode() {
  const ordering = new StorageBufferAttribute(new Uint32Array([0xffffffff]), 1);
  ordering.name = "GaussianSplatOrdering";
  return N.storage(ordering, "uint").toReadOnly();
}

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

const stochasticHash = N.Fn(([input]: TSLNode[]) => {
  const value = N.uint(input).toVar();
  value.bitXorAssign(value.shiftRight(16));
  value.mulAssign(N.uint(0x7feb352d));
  value.bitXorAssign(value.shiftRight(15));
  value.mulAssign(N.uint(0x846ca68b));
  value.bitXorAssign(value.shiftRight(16));
  return value;
});

function createSplatFragment({
  minAlpha,
  stochastic,
  stochasticResolve,
  depthOnly,
  premultipliedAlpha,
}: {
  minAlpha: TSLNode;
  stochastic: TSLNode;
  stochasticResolve: TSLNode;
  depthOnly: TSLNode;
  premultipliedAlpha: TSLNode;
}) {
  const vRgba = N.varyingProperty("vec4", "gslRgba");
  const vSplatUv = N.varyingProperty("vec2", "gslSplatUv");
  const vSplatIndex = N.varyingProperty("uint", "gslSplatIndex");
  const vSupportRadiusSquared = N.varyingProperty(
    "float",
    "gslSupportRadiusSquared",
  );
  const vKernelPower = N.varyingProperty("float", "gslKernelPower");
  const vViewportOrigin = N.varyingProperty("vec2", "gslViewportOrigin");

  const fragmentNode = N.Fn(() => {
    const rgba = vRgba.toVar();
    const z2 = vSplatUv.dot(vSplatUv);
    z2.greaterThan(vSupportRadiusSquared).discard();
    const kernelAlpha = z2.mul(-0.5).exp().toVar();
    N.If(vKernelPower.notEqual(0), () => {
      kernelAlpha.assign(
        N.float(1).sub(N.float(1).sub(kernelAlpha).pow(vKernelPower)),
      );
    });
    rgba.a.mulAssign(kernelAlpha);
    rgba.a.lessThan(minAlpha).discard();
    N.If(stochastic.or(depthOnly), () => {
      const pixel = N.uvec2(N.screenCoordinate.xy.sub(vViewportOrigin));
      const quad = pixel.shiftRight(N.uvec2(1));
      const hash = stochasticHash(
        quad.x
          .mul(N.uint(1973))
          .bitXor(quad.y.mul(N.uint(9277)))
          .bitXor(vSplatIndex.add(1).mul(N.uint(26699))),
      );
      const stratum = pixel.y
        .bitAnd(1)
        .mul(2)
        .add(pixel.x.bitAnd(1))
        .bitXor(hash.bitAnd(3));
      const randomValue = N.float(stratum)
        .add(N.float(hash.shiftRight(8)).mul(1 / 16777216))
        .mul(0.25);
      randomValue.greaterThanEqual(rgba.a).discard();
    });
    N.If(depthOnly.not(), () => {
      N.If(stochastic, () => {
        // NodeMaterial premultiplies its output when requested. Cancel the
        // alpha-2 marker here so the stored stochastic RGB remains straight.
        N.If(premultipliedAlpha.and(stochasticResolve), () => {
          rgba.rgb.mulAssign(0.5);
        });
        rgba.a.assign(N.select(stochasticResolve, 2, 1));
      });
    });
    return rgba;
  })();

  return {
    vRgba,
    vSplatUv,
    vSplatIndex,
    vSupportRadiusSquared,
    vKernelPower,
    vViewportOrigin,
    fragmentNode,
  };
}

export function createWebGPUSplatMaterial({
  uniforms,
  orderingNode: providedOrderingNode,
  premultipliedAlpha,
  transparent,
  depthTest,
  depthWrite,
}: {
  uniforms: Uniforms;
  orderingNode?: TSLNode;
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
}): WebGPUSplatMaterial {
  const orderingNode = providedOrderingNode ?? createDefaultOrderingNode();
  const splats = textureBinding(uniforms, "splats", true);
  const splats2 = textureBinding(uniforms, "splats2", true);
  const maxStdDev = uniformBinding(uniforms, "maxStdDev", "float");
  const minPixelRadius = uniformBinding(uniforms, "minPixelRadius", "float");
  const maxPixelRadius = uniformBinding(uniforms, "maxPixelRadius", "float");
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
  const preBlurAmount = uniformBinding(uniforms, "preBlurAmount", "float");
  const blurAmount = uniformBinding(uniforms, "blurAmount", "float");
  const clipXY = uniformBinding(uniforms, "clipXY", "float");
  const focalAdjustment = uniformBinding(uniforms, "focalAdjustment", "float");
  const encodeLinear = uniformBinding(uniforms, "encodeLinear", "bool");
  const premultipliedAlphaNode = uniformBinding(
    uniforms,
    "premultipliedAlpha",
    "bool",
  );
  const stochastic = uniformBinding(uniforms, "stochastic", "bool");
  const stochasticResolve = uniformBinding(
    uniforms,
    "stochasticResolve",
    "bool",
  );
  const depthOnly = uniformBinding(uniforms, "depthOnly", "bool");
  const {
    vRgba,
    vSplatUv,
    vSplatIndex,
    vSupportRadiusSquared,
    vKernelPower,
    vViewportOrigin,
    fragmentNode,
  } = createSplatFragment({
    minAlpha,
    stochastic,
    stochasticResolve,
    depthOnly,
    premultipliedAlpha: premultipliedAlphaNode,
  });

  const vertexNode = N.Fn(({ camera }: { camera: THREE.Camera }) => {
    const {
      renderSize,
      viewportOrigin,
      renderToViewQuat,
      renderToViewPos,
      renderToViewScale,
      near,
      far,
    } = splatViewUniforms(uniforms, camera);
    vViewportOrigin.assign(viewportOrigin);
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vRgba.assign(N.vec4(0));
    vSplatUv.assign(N.vec2(0));
    vSplatIndex.assign(N.uint(0));
    vSupportRadiusSquared.assign(0);
    vKernelPower.assign(0);

    const splatIndex = N.uint(N.instanceIndex).toVar();
    N.If(stochastic.or(depthOnly).not(), () => {
      splatIndex.assign(orderingNode.element(N.uint(N.instanceIndex)));
    });

    N.If(splatIndex.notEqual(N.uint(0xffffffff)), () => {
      const texCoord = splatTexCoord(splatIndex);
      const first = loadArray(splats, texCoord);
      const alphaShape = decodeAlphaShape(first);
      const alpha = alphaShape.x.toVar();

      N.If(alpha.greaterThanEqual(minAlpha).and(alpha.greaterThan(0)), () => {
        const center = decodeCenter(first);
        const viewCenter = quatVec(renderToViewQuat, center)
          .mul(renderToViewScale)
          .add(renderToViewPos);
        const projectionMatrix = N.cameraProjectionMatrix;
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
          const second = loadArray(splats2, texCoord);
          const lnScales = decodeLnScales(second);
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
              decodeQuaternion(second.w),
            );
            const rotationScale = scaleQuaternionToMatrix(
              scales,
              viewQuaternion,
            );
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
            const det = a.mul(d).sub(b.mul(b));
            alpha.mulAssign(detOrig.div(det).max(0).sqrt());

            N.If(alpha.greaterThanEqual(minAlpha), () => {
              N.If(kernelPower.equal(0), () => {
                supportRadius.assign(
                  gaussianSupportRadius(alpha, supportRadius, minAlpha),
                );
              }).Else(() => {
                supportRadius.assign(
                  wideSupportRadius(
                    alpha,
                    kernelPower,
                    supportRadius,
                    minAlpha,
                  ),
                );
              });
              const eigenAverage = a.add(d).mul(0.5);
              const eigenDelta = eigenAverage
                .mul(eigenAverage)
                .sub(det)
                .max(0)
                .sqrt();
              const eigen1 = eigenAverage.add(eigenDelta);
              const eigen2 = eigenAverage.sub(eigenDelta);
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

              N.If(
                fullScale1
                  .mul(cullScale)
                  .greaterThanEqual(minPixelRadius)
                  .or(
                    fullScale2.mul(cullScale).greaterThanEqual(minPixelRadius),
                  ),
                () => {
                  const pixelOffset = eigenVector1
                    .mul(N.positionGeometry.x)
                    .mul(scale1)
                    .add(eigenVector2.mul(N.positionGeometry.y).mul(scale2));
                  const ndcOffset = pixelOffset.mul(2).div(scaledRenderSize);
                  const ndcCenter = clipCenter.xyz.div(clipCenter.w);
                  clipPosition.assign(
                    N.vec4(
                      ndcCenter.xy.add(ndcOffset).mul(clipCenter.w),
                      clipCenter.zw,
                    ),
                  );
                  const rgb = decodeRgba(second, alpha).rgb.max(0).toVar();
                  // RGB is constant across the quad; decode its color space once
                  // per vertex rather than for every covered fragment.
                  N.If(encodeLinear.and(depthOnly.not()), () => {
                    rgb.assign(rgb.pow(2.2));
                  });
                  vRgba.assign(N.vec4(rgb, alpha));
                  vSplatUv.assign(N.positionGeometry.xy.mul(supportRadius));
                  vSplatIndex.assign(splatIndex);
                  vSupportRadiusSquared.assign(
                    supportRadius.mul(supportRadius),
                  );
                  vKernelPower.assign(kernelPower);
                },
              );
            });
          });
        });
      });
    });

    return clipPosition;
  })();

  const material = new NodeMaterial();
  material.vertexNode = vertexNode;
  material.colorNode = fragmentNode;
  material.premultipliedAlpha = premultipliedAlpha;
  material.transparent = transparent;
  material.depthTest = depthTest;
  material.depthWrite = depthWrite;
  material.side = THREE.FrontSide;
  material.allowOverride = false;
  material.fog = false;
  material.toneMapped = false;
  return Object.assign(material, { uniforms, orderingNode });
}
