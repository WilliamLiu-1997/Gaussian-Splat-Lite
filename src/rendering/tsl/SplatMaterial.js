import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { registerStochasticSplatMaterial } from "../StochasticSplatMaterial.js";
import { ORDERING_TEXTURE_WIDTH } from "../uniforms.js";
import { createProjectionProgram } from "./ProjectionProgram.js";
import {
  N,
  load2D,
  loadArray,
  splatTexCoord,
  textureBinding,
  uniformBinding,
} from "./shaderUtils.js";
import { stochasticCoverage } from "./stochasticCoverage.js";
import { splatViewUniforms } from "./viewUniforms.js";
const stochasticHash = N.Fn(([input]) => {
  const value = N.uint(input).toVar();
  value.bitXorAssign(value.shiftRight(16));
  value.mulAssign(N.uint(0x7feb352d));
  value.bitXorAssign(value.shiftRight(15));
  value.mulAssign(N.uint(0x846ca68b));
  value.bitXorAssign(value.shiftRight(16));
  return value;
});
function createSplatFragment(
  minAlpha,
  edgeFade,
  stochasticNoise,
  coverage,
  effect,
  encodeLinear,
) {
  // Per-Splat constants share one flat varying: RGB and kernel power as
  // halves, alpha and squared support radius as float32 bits. See packSplatVarying.
  const vSplat = N.varyingProperty("uvec4", "gslSplat");
  const vSplatUv = N.varyingProperty("vec2", "gslSplatUv");
  // Atlas offset: x in bits 0-4, y in 5-9, time in 10-14. See stochasticTileOffset.
  const vStochasticOffset = stochasticNoise
    ? N.varyingProperty("uint", "gslStochasticOffset")
    : null;
  const vEffectCenter = effect
    ? N.varyingProperty("vec3", "gslEffectCenter")
    : null;
  const vEffectNormal = effect?.normals
    ? N.varyingProperty("vec3", "gslEffectNormal")
    : null;
  const fragmentNode = N.Fn((builder) => {
    const z2 = vSplatUv.dot(vSplatUv);
    z2.greaterThan(N.uintBitsToFloat(vSplat.w)).discard();
    const blueKernelPower = N.unpackHalf2x16(vSplat.y);
    const kernelPower = blueKernelPower.y;
    const kernelAlpha = z2.mul(-0.5).exp().toVar();
    const peakAlpha = N.uintBitsToFloat(vSplat.z);
    // A kernel still above minAlpha where its support ends fades to minAlpha
    // there: it is rescaled about its peak. A Gaussian's fade follows from
    // its alpha; a wide kernel carries its own in the low half of its squared
    // radius.
    const fade = N.float(0).toVar();
    N.If(kernelPower.notEqual(0), () => {
      kernelAlpha.assign(
        N.float(1).sub(N.float(1).sub(kernelAlpha).pow(kernelPower)),
      );
      fade.assign(N.unpackHalf2x16(vSplat.w).x);
    }).Else(() => {
      fade.assign(peakAlpha.mul(edgeFade.x).sub(edgeFade.y).max(0));
    });
    const alpha = peakAlpha.add(fade).mul(kernelAlpha).sub(fade).toVar();
    const color = effect
      ? N.vec3(N.unpackHalf2x16(vSplat.x), blueKernelPower.x).toVar()
      : null;
    const context = effect
      ? {
          color,
          alpha,
          viewCenter: vEffectCenter,
          viewNormal: vEffectNormal ?? undefined,
          splatUv: vSplatUv,
          screenUV: N.screenUV,
          camera: builder.camera,
          uniforms: effect.nodes,
        }
      : null;
    if (effect?.definition.tsl.opacity) {
      alpha.assign(effect.definition.tsl.opacity(context).clamp(0, alpha));
    }
    alpha.lessThanEqual(0).or(alpha.lessThan(minAlpha)).discard();
    if (stochasticNoise && vStochasticOffset) {
      // Stagger blocks per Splat, then vary their spatial offset quadratically.
      // The offset stays fixed over time, preserving each pixel's STBN sequence.
      const seedOffset = N.uvec2(
        vStochasticOffset,
        vStochasticOffset.shiftRight(5),
      ).bitAnd(31);
      const pixel = N.uvec2(N.screenCoordinate.xy).add(seedOffset).toVar();
      const tile = pixel.shiftRight(N.uvec2(5)).toVar();
      const shift = tile
        .mul(tile.add(1))
        .shiftRight(N.uvec2(1))
        .add(tile.x.mul(tile.y))
        .add(tile.yx);
      const sample = pixel.add(shift).bitAnd(31).toVar();
      const coord = N.ivec2(
        sample.x,
        sample.y.add(vStochasticOffset.shiftRight(10).mul(32)),
      );
      const randomValue = N.float(load2D(stochasticNoise, coord).r)
        .add(0.5)
        .div(32768);
      if (coverage) coverage(alpha, randomValue);
      else randomValue.greaterThanEqual(alpha).discard();
    }
    if (effect) {
      if (effect.definition.tsl.shadeFragment)
        color.assign(effect.definition.tsl.shadeFragment(context));
      N.If(encodeLinear.not(), () => {
        color.assign(N.sRGBTransferOETF(color));
      });
      return N.vec4(color, stochasticNoise ? 1 : alpha);
    }
    // Decode color only after the fragment survives coverage tests.
    return N.vec4(
      N.unpackHalf2x16(vSplat.x),
      blueKernelPower.x,
      stochasticNoise ? 1 : alpha,
    );
  })();
  return {
    vSplat,
    vSplatUv,
    vStochasticOffset,
    vEffectCenter,
    vEffectNormal,
    fragmentNode,
  };
}
// Keep XY fixed while advancing the STBN time axis. Independent per-Splat XYZ
// offsets decorrelate overlapping coverage tests without translating the field.
function stochasticTileOffset(seed, sample, viewportOrigin) {
  const hash = stochasticHash(seed).toVar();
  const origin = N.uvec2(viewportOrigin);
  const x = hash.sub(origin.x);
  const y = hash.shiftRight(5).sub(origin.y);
  const phase = hash.shiftRight(10).add(sample).bitAnd(31);
  return x
    .bitAnd(31)
    .bitOr(y.bitAnd(31).shiftLeft(5))
    .bitOr(phase.shiftLeft(10));
}
// Half RGB saturates at its largest finite value instead of overflowing after
// sRGB linearization. Source alpha keeps float32 bits, but half kernel power
// can still change the final coverage of wide kernels. The squared support
// radius passes bit for bit: a wide kernel's low half is its edge fade.
function packSplatVarying(rgba, supportRadiusSquared, kernelPower) {
  const rgb = rgba.rgb.min(65504);
  return N.uvec4(
    N.packHalf2x16(rgb.xy),
    N.packHalf2x16(N.vec2(rgb.z, kernelPower)),
    N.floatBitsToUint(rgba.a),
    N.floatBitsToUint(supportRadiusSquared),
  );
}
/**
 * Sorted and stochastic variants compile separate graphs, so sorted drawing
 * carries no coverage varyings, seed loads or mode branches.
 */
export function createSplatNodeMaterial({
  uniforms,
  orderingNode,
  vertexData,
  premultipliedAlpha,
  transparent,
  depthTest,
  depthWrite,
  stochastic,
  effect = null,
}) {
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
  const edgeFade = uniformBinding(uniforms, "edgeFade", "vec2");
  const encodeLinear = uniformBinding(uniforms, "encodeLinear", "bool");
  const stochasticSample = stochastic
    ? uniformBinding(uniforms, "stochasticSample", "uint")
    : null;
  // Accumulator textures are only read without a projection cache.
  const accumulator = vertexData
    ? null
    : {
        splats: textureBinding(uniforms, "splats"),
        splats2: textureBinding(uniforms, "splats2"),
        seeds: stochastic ? textureBinding(uniforms, "stochasticSeeds") : null,
      };
  const stochasticNoise = stochastic
    ? textureBinding(uniforms, "stochasticNoise")
    : null;
  const fragment = (coverage) =>
    createSplatFragment(
      minAlpha,
      edgeFade,
      stochasticNoise,
      coverage,
      effect,
      encodeLinear,
    );
  const {
    vSplat,
    vSplatUv,
    vStochasticOffset,
    vEffectCenter,
    vEffectNormal,
    fragmentNode,
  } = fragment();
  function buildVertex(builder) {
    const camera = builder.camera;
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vSplat.assign(N.uvec4(0));
    vSplatUv.assign(N.vec2(0));
    vStochasticOffset?.assign(N.uint(0));
    vEffectCenter?.assign(N.vec3(0));
    vEffectNormal?.assign(N.vec3(0, 0, 1));
    const assignVertexData = (data) => {
      const rgba = data.rgba.toVar();
      // Projection supplies source RGB; this material applies encodeLinear.
      // RGB is constant across the quad, so decode its color space once
      // per vertex rather than for every covered fragment.
      if (effect) {
        rgba.rgb.assign(N.sRGBTransferEOTF(rgba.rgb));
        vEffectCenter.assign(data.viewCenter);
        vEffectNormal?.assign(data.viewNormal);
        if (effect.definition.tsl.shadeSplat) {
          rgba.rgb.assign(
            effect.definition.tsl.shadeSplat({
              color: rgba.rgb,
              viewCenter: data.viewCenter,
              viewNormal: effect.normals ? data.viewNormal : undefined,
              camera,
              uniforms: effect.nodes,
            }),
          );
        }
      } else {
        N.If(encodeLinear, () => {
          rgba.rgb.assign(N.sRGBTransferEOTF(rgba.rgb));
        });
      }
      clipPosition.assign(data.clipPosition);
      vSplat.assign(
        packSplatVarying(rgba, data.supportRadiusSquared, data.kernelPower),
      );
      vSplatUv.assign(data.splatUv);
      if (vStochasticOffset && stochasticSample && data.stochasticSeed) {
        // Coverage uses the same offset across every fragment of this Splat.
        vStochasticOffset.assign(
          stochasticTileOffset(
            data.stochasticSeed,
            stochasticSample,
            data.viewportOrigin,
          ),
        );
      }
    };
    if (vertexData) {
      assignVertexData(vertexData(camera, stochastic, effect));
      return clipPosition;
    }
    if (!accumulator || !orderingNode) {
      throw new Error("Accumulator splat drawing requires an ordering texture");
    }
    const view = splatViewUniforms(uniforms, camera);
    const project = createProjectionProgram(
      uniforms,
      view,
      effect?.normals ?? false,
    );
    const index = N.uint(N.instanceIndex)
      .mul(SPLATS_PER_INSTANCE)
      .add(N.uint(N.positionGeometry.z))
      .toVar();
    const splatIndex = N.uint(0xffffffff).toVar();
    // Every view, including both WebXR eyes, draws the one shared order.
    const loadOrdered = () => {
      const texel = index.shiftRight(2);
      const coord = N.ivec2(
        texel.mod(ORDERING_TEXTURE_WIDTH),
        texel.div(N.uint(ORDERING_TEXTURE_WIDTH)),
      );
      splatIndex.assign(load2D(orderingNode, coord).element(index.bitAnd(3)));
    };
    N.If(index.lessThan(uniformBinding(uniforms, "splatCount", "uint")), () => {
      if (!stochastic) {
        loadOrdered();
        return;
      }
      // Unsorted stochastic draws use source indices directly.
      splatIndex.assign(index);
      N.If(uniformBinding(uniforms, "stochasticOrdering", "bool"), loadOrdered);
    });
    N.If(splatIndex.notEqual(N.uint(0xffffffff)), () => {
      const texCoord = splatTexCoord(splatIndex);
      const first = loadArray(accumulator.splats, texCoord);
      const projected = project({
        first,
        second: loadArray(accumulator.splats2, texCoord),
      });
      N.If(projected.valid, () => {
        const ndcOffset = projected.axis1
          .mul(N.positionGeometry.x)
          .add(projected.axis2.mul(N.positionGeometry.y));
        const ndcCenter = projected.clipCenter.xyz.div(projected.clipCenter.w);
        assignVertexData({
          clipPosition: N.vec4(
            ndcCenter.xy.add(ndcOffset).mul(projected.clipCenter.w),
            projected.clipCenter.zw,
          ),
          rgba: projected.rgba,
          viewCenter: projected.viewCenter,
          viewNormal: projected.viewNormal,
          splatUv: N.positionGeometry.xy.mul(projected.supportRadius),
          // Fetch stable coverage seeds only after all projection cutoffs.
          stochasticSeed: accumulator.seeds
            ? loadArray(accumulator.seeds, texCoord).r
            : undefined,
          supportRadiusSquared: projected.supportRadiusSquared,
          kernelPower: projected.kernelPower,
          viewportOrigin: view.viewportOrigin,
        });
      });
    });
    return clipPosition;
  }
  const material = Object.assign(new NodeMaterial(), {
    uniforms,
    vertexNode: N.Fn(buildVertex)(),
    colorNode: fragmentNode,
    premultipliedAlpha,
    transparent,
    depthTest,
    depthWrite,
    side: THREE.FrontSide,
    allowOverride: false,
    fog: false,
    toneMapped: false,
  });
  if (stochastic) {
    registerStochasticSplatMaterial(material, () =>
      Object.assign(material.clone(), {
        uniforms: material.uniforms,
        colorNode: fragment(stochasticCoverage).fragmentNode,
      }),
    );
  }
  return material;
}
