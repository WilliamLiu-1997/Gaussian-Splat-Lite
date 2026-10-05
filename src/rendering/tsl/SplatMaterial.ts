import * as THREE from "three";
import type { Node, NodeBuilder } from "three/webgpu";
import { NodeMaterial, type TextureNode } from "three/webgpu";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry";
import { ORDERING_TEXTURE_WIDTH, type Uniforms } from "../uniforms";
import { createProjectionProgram } from "./ProjectionProgram";
import {
  N,
  load2D,
  loadArray,
  splatTexCoord,
  textureBinding,
  uniformBinding,
} from "./shaderUtils";
import { materialCamera } from "./tslCompat";
import { splatViewUniforms } from "./viewUniforms";

export type ProjectedVertexData = {
  clipPosition: Node<"vec4">;
  /** Source color space; this material applies encodeLinear. */
  rgba: Node<"vec4">;
  splatUv: Node<"vec2">;
  /** Stochastic variant only. */
  stochasticSeed?: Node<"uint">;
  /** A wide kernel's low 16 bits hold its edge fade as a half. */
  supportRadiusSquared: Node<"float">;
  kernelPower: Node<"float">;
  viewportOrigin: Node<"vec2">;
};

export type SplatNodeMaterial = NodeMaterial & { uniforms: Uniforms };

const stochasticHash = N.Fn(([input]: [Node<"uint">]) => {
  const value = N.uint(input).toVar();
  value.bitXorAssign(value.shiftRight(16));
  value.mulAssign(N.uint(0x7feb352d));
  value.bitXorAssign(value.shiftRight(15));
  value.mulAssign(N.uint(0x846ca68b));
  value.bitXorAssign(value.shiftRight(16));
  return value;
});

function createSplatFragment(
  minAlpha: Node<"float">,
  edgeFade: Node<"vec2">,
  stochasticNoise: TextureNode<"uvec4"> | null,
) {
  // Per-Splat constants share one flat varying: RGB and kernel power as
  // halves, alpha and squared support radius as float32 bits. See packSplatVarying.
  const vSplat = N.varyingProperty("uvec4", "gslSplat");
  const vSplatUv = N.varyingProperty("vec2", "gslSplatUv");
  // Atlas offset: x in bits 0-4, y in 5-9, time in 10-14. See stochasticTileOffset.
  const vStochasticOffset = stochasticNoise
    ? N.varyingProperty("uint", "gslStochasticOffset")
    : null;

  const fragmentNode = N.Fn(() => {
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
    alpha.lessThan(minAlpha).discard();
    if (stochasticNoise && vStochasticOffset) {
      const pixel = N.uvec2(N.screenCoordinate.xy);
      const coord = N.ivec2(
        pixel.x.add(vStochasticOffset).bitAnd(31),
        pixel.y
          .add(vStochasticOffset.shiftRight(5))
          .bitAnd(31)
          .add(vStochasticOffset.shiftRight(10).mul(32)),
      );
      const randomValue = N.float(load2D(stochasticNoise, coord).r)
        .add(0.5)
        .div(32768);
      randomValue.greaterThanEqual(alpha).discard();
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
    fragmentNode,
  };
}

// Keep XY fixed while advancing the STBN time axis. Independent per-Splat XYZ
// offsets decorrelate overlapping coverage tests without translating the field.
function stochasticTileOffset(
  seed: Node<"uint">,
  sample: Node<"uint">,
  viewportOrigin: Node<"vec2">,
) {
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
function packSplatVarying(
  rgba: Node<"vec4">,
  supportRadiusSquared: Node<"float">,
  kernelPower: Node<"float">,
) {
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
}: {
  uniforms: Uniforms;
  /** CPU ordering for drawing from accumulator textures. */
  orderingNode?: TextureNode<"uvec4">;
  /** Replaces accumulator projection, e.g. with a GPU projection cache. */
  vertexData?: (
    camera: THREE.Camera,
    stochastic: boolean,
  ) => ProjectedVertexData;
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  stochastic: boolean;
}): SplatNodeMaterial {
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
        splats: textureBinding(uniforms, "splats", true),
        splats2: textureBinding(uniforms, "splats2", true),
        seeds: stochastic
          ? textureBinding(uniforms, "stochasticSeeds", true)
          : null,
      };
  const { vSplat, vSplatUv, vStochasticOffset, fragmentNode } =
    createSplatFragment(
      minAlpha,
      edgeFade,
      stochastic ? textureBinding(uniforms, "stochasticNoise") : null,
    );

  function buildVertex(builder: NodeBuilder) {
    const camera = materialCamera(builder);
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vSplat.assign(N.uvec4(0));
    vSplatUv.assign(N.vec2(0));
    vStochasticOffset?.assign(N.uint(0));
    const assignVertexData = (data: ProjectedVertexData) => {
      const rgba = data.rgba.toVar();
      // RGB is constant across the quad; decode its color space once
      // per vertex rather than for every covered fragment.
      N.If(encodeLinear, () => {
        rgba.rgb.assign(N.sRGBTransferEOTF(rgba.rgb));
      });
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
      assignVertexData(vertexData(camera, stochastic));
      return clipPosition;
    }
    if (!accumulator || !orderingNode) {
      throw new Error("Accumulator splat drawing requires an ordering texture");
    }

    const view = splatViewUniforms(uniforms, camera);
    const project = createProjectionProgram(uniforms, {
      ...view,
      projectionMatrix: N.cameraProjectionMatrix,
    });
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

  return Object.assign(new NodeMaterial(), {
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
}
