import * as THREE from "three";
import * as TSL from "three/tsl";
import { NodeMaterial, StorageBufferAttribute } from "three/webgpu";

import { SPLAT_TEX_HEIGHT_BITS, SPLAT_TEX_WIDTH_BITS } from "./defines";

// Three's public TSL typings intentionally expose concrete node types rather
// than one common chainable interface. Keep the shader translation readable.
// biome-ignore lint/suspicious/noExplicitAny: TSL nodes are dynamically typed.
type TSLNode = any;
const N = TSL as Record<string, TSLNode>;

const SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_WIDTH_MASK = (1 << SPLAT_TEX_WIDTH_BITS) - 1;
const SPLAT_TEX_HEIGHT_MASK = (1 << SPLAT_TEX_HEIGHT_BITS) - 1;
const E = Math.E;
const MAX_SEMANTIC_OPACITY = 1000;
// WGSL rejects non-finite constant expressions, so keep infinity in a runtime
// uniform for SDF reductions and deleted-splat handling.
const FLOAT_INFINITY = N.uniform(Number.POSITIVE_INFINITY, "float");

type Uniforms = Record<string, THREE.IUniform>;
type WebGPUCompatibleNodeMaterial = NodeMaterial & { uniforms: Uniforms };
export type WebGPUSplatMaterial = WebGPUCompatibleNodeMaterial & {
  orderingNode: TSLNode;
};

function uniformBinding(uniforms: Uniforms, name: string, type?: string) {
  return N.uniform(uniforms[name].value, type).onObjectUpdate(
    () => uniforms[name].value,
  );
}

function splatViewUniforms(uniforms: Uniforms, camera: THREE.Camera) {
  const arrayCamera = camera as THREE.ArrayCamera;
  if (!arrayCamera.isArrayCamera || arrayCamera.cameras.length === 0) {
    return {
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
      renderToViewQuat: uniformBinding(uniforms, "renderToViewQuat", "vec4"),
      renderToViewPos: uniformBinding(uniforms, "renderToViewPos", "vec3"),
      renderToViewScale: uniformBinding(uniforms, "renderToViewScale", "float"),
      near: uniformBinding(uniforms, "near", "float"),
      far: uniformBinding(uniforms, "far", "float"),
    };
  }

  // ArrayCamera draws do not call onBeforeRender separately for each eye.
  // Pack rotation, position/scale and viewport/clipping into three vec4s per eye.
  const views = arrayCamera.cameras.flatMap(() => [
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
        views[i * 3].set(rotation.x, rotation.y, rotation.z, rotation.w);
        views[i * 3 + 1].set(
          position.x,
          position.y,
          position.z,
          (scale.x + scale.y + scale.z) / 3,
        );
        const size = uniforms.renderSize.value;
        views[i * 3 + 2].set(
          eye.viewport?.z ?? size.x,
          eye.viewport?.w ?? size.y,
          eye.near,
          eye.far,
        );
      });
    },
  );
  const index = (camera as THREE.ArrayCamera & { isMultiViewCamera?: boolean })
    .isMultiViewCamera
    ? N.builtin("gl_ViewID_OVR")
    : N.cameraIndex;
  const offset = index.mul(3);
  const positionScale = viewData.element(offset.add(1));
  const viewportClip = viewData.element(offset.add(2));
  return {
    renderSize: viewportClip.xy,
    renderToViewQuat: viewData.element(offset),
    renderToViewPos: positionScale.xyz,
    renderToViewScale: positionScale.w,
    near: viewportClip.z,
    far: viewportClip.w,
  };
}

function textureBinding(uniforms: Uniforms, name: string, array = false) {
  const data = new Uint32Array(4);
  const placeholder = array
    ? new THREE.DataArrayTexture(data, 1, 1, 1)
    : new THREE.DataTexture(data, 1, 1);
  placeholder.format = THREE.RGBAIntegerFormat;
  placeholder.type = THREE.UnsignedIntType;
  placeholder.magFilter = THREE.NearestFilter;
  placeholder.minFilter = THREE.NearestFilter;
  placeholder.generateMipmaps = false;
  placeholder.needsUpdate = true;

  const getTexture = () => uniforms[name].value as THREE.Texture;
  return N.textureLoad(placeholder).onObjectUpdate(getTexture);
}

function createDefaultOrderingNode() {
  const ordering = new StorageBufferAttribute(new Uint32Array([0xffffffff]), 1);
  ordering.name = "GaussianSplatOrdering";
  return N.storage(ordering, "uint").toReadOnly();
}

function load2D(binding: TSLNode, coord: TSLNode) {
  const texel = binding.load(coord);
  texel.setUpdateMatrix(false);
  return texel;
}

function loadArray(binding: TSLNode, coord: TSLNode) {
  return binding.load(coord.xy).depth(coord.z);
}

export const splatTexCoord = N.Fn(([index]: TSLNode[]) => {
  const value = N.uint(index);
  return N.ivec3(
    N.int(value.bitAnd(SPLAT_TEX_WIDTH_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_WIDTH_BITS).bitAnd(SPLAT_TEX_HEIGHT_MASK)),
    N.int(value.shiftRight(SPLAT_TEX_LAYER_BITS)),
  );
});

const quatVec = N.Fn(([quaternion, vector]: TSLNode[]) => {
  const t = quaternion.xyz.cross(vector).mul(2);
  return vector.add(quaternion.w.mul(t)).add(quaternion.xyz.cross(t));
});

const quatQuat = N.Fn(([first, second]: TSLNode[]) => {
  return N.vec4(
    first.w
      .mul(second.x)
      .add(first.x.mul(second.w))
      .add(first.y.mul(second.z))
      .sub(first.z.mul(second.y)),
    first.w
      .mul(second.y)
      .sub(first.x.mul(second.z))
      .add(first.y.mul(second.w))
      .add(first.z.mul(second.x)),
    first.w
      .mul(second.z)
      .add(first.x.mul(second.y))
      .sub(first.y.mul(second.x))
      .add(first.z.mul(second.w)),
    first.w
      .mul(second.w)
      .sub(first.x.mul(second.x))
      .sub(first.y.mul(second.y))
      .sub(first.z.mul(second.z)),
  );
});

const decodeCenter = N.Fn(([data]: TSLNode[]) => {
  return N.uintBitsToFloat(data.xyz);
});

const decodeAlphaShape = N.Fn(([data]: TSLNode[]) => {
  return N.unpackHalf2x16(data.w);
});

const decodeRgba = N.Fn(([data, alpha]: TSLNode[]) => {
  return N.vec4(N.unpackHalf2x16(data.x), N.unpackHalf2x16(data.y).x, alpha);
});

const decodeLnScales = N.Fn(([data]: TSLNode[]) => {
  return N.vec3(N.unpackHalf2x16(data.y).y, N.unpackHalf2x16(data.z));
});

const decodeQuaternion = N.Fn(([encodedValue]: TSLNode[]) => {
  const encoded = N.uint(encodedValue);
  const quantU = encoded.bitAnd(0x3ff);
  const quantV = encoded.shiftRight(10).bitAnd(0x3ff);
  const angleInt = encoded.shiftRight(20);
  const folded = N.vec2(N.float(quantU), N.float(quantV))
    .div(1023)
    .mul(2)
    .sub(1);
  const axis = N.vec3(
    folded,
    N.float(1).sub(folded.x.abs()).sub(folded.y.abs()),
  ).toVar();
  const t = axis.z.negate().max(0);
  axis.x.addAssign(N.select(axis.x.greaterThanEqual(0), t.negate(), t));
  axis.y.addAssign(N.select(axis.y.greaterThanEqual(0), t.negate(), t));
  axis.assign(axis.normalize());

  const halfTheta = N.float(angleInt)
    .div(4095)
    .mul(Math.PI * 0.5);
  return N.vec4(axis.mul(halfTheta.sin()), halfTheta.cos());
});

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

const stochasticHash = N.Fn(([input]: TSLNode[]) => {
  const value = N.uint(input).toVar();
  value.bitXorAssign(value.shiftRight(16));
  value.mulAssign(N.uint(0x7feb352d));
  value.bitXorAssign(value.shiftRight(15));
  value.mulAssign(N.uint(0x846ca68b));
  value.bitXorAssign(value.shiftRight(16));
  return value;
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

function createSplatFragment({
  minAlpha,
  encodeLinear,
  stochastic,
  stochasticResolve,
  depthOnly,
  premultipliedAlpha,
}: {
  minAlpha: TSLNode;
  encodeLinear: TSLNode;
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
      const pixel = N.uvec2(N.screenCoordinate.xy);
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
      N.If(encodeLinear, () => {
        rgba.rgb.assign(rgba.rgb.pow(2.2));
      });
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
    fragmentNode,
  } = createSplatFragment({
    minAlpha,
    encodeLinear,
    stochastic,
    stochasticResolve,
    depthOnly,
    premultipliedAlpha: premultipliedAlphaNode,
  });

  const vertexNode = N.Fn(({ camera }: { camera: THREE.Camera }) => {
    const {
      renderSize,
      renderToViewQuat,
      renderToViewPos,
      renderToViewScale,
      near,
      far,
    } = splatViewUniforms(uniforms, camera);
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
            const rgba = decodeRgba(second, alpha);
            rgba.rgb.assign(rgba.rgb.max(0));
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
            const scaledRenderSize = renderSize.mul(focalAdjustment);
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
            const detOrig = a.mul(d).sub(b.mul(b));
            a.addAssign(blurAmount);
            d.addAssign(blurAmount);
            const det = a.mul(d).sub(b.mul(b));
            alpha.mulAssign(detOrig.div(det).max(0).sqrt());

            N.If(alpha.greaterThanEqual(minAlpha), () => {
              N.If(kernelPower.equal(0), () => {
                supportRadius.assign(
                  gaussianSupportRadius(alpha, supportRadius, minAlpha),
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
              const scale1 = maxPixelRadius
                .min(maximumSupportRadius.mul(eigen1.sqrt()))
                .mul(supportScale);
              const scale2 = maxPixelRadius
                .min(maximumSupportRadius.mul(eigen2.sqrt()))
                .mul(supportScale);

              N.If(
                scale1
                  .greaterThanEqual(minPixelRadius)
                  .or(scale2.greaterThanEqual(minPixelRadius)),
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
                  vRgba.assign(N.vec4(rgba.rgb, alpha));
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
