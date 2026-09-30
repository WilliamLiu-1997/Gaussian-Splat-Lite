import * as THREE from "three";
import type { Node, NodeBuilder } from "three/webgpu";
import {
  NodeMaterial,
  StorageBufferAttribute,
  type StorageBufferNode,
  type TextureNode,
} from "three/webgpu";
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
  stochasticSeed: Node<"uint">;
  supportRadiusSquared: Node<"float">;
  kernelPower: Node<"float">;
  viewportOrigin: Node<"vec2">;
};

export type OrderingNode = StorageBufferNode<"uint"> | TextureNode<"uvec4">;

/** One front-to-back batch of the CPU-sorted order: ranks first..first+count. */
export type LayeredBatch = {
  first: Node<"uint">;
  count: Node<"uint">;
};

/** Front-to-back layers that the Splat's own draw composites while active. */
export type LayeredComposite = {
  active: Node<"bool">;
  /** Premultiplied RGB and remaining transmittance. */
  layers: TextureNode<"vec4">;
};

export type SplatNodeMaterial = NodeMaterial & {
  uniforms: Uniforms;
  orderingNode: OrderingNode;
  vertexNode: Node<"vec4">;
};

function createDefaultOrderingNode() {
  const ordering = new StorageBufferAttribute(new Uint32Array([0xffffffff]), 1);
  ordering.name = "GaussianSplatOrdering";
  return N.storage(ordering, "uint").toReadOnly();
}

const stochasticHash = N.Fn(([input]: [Node<"uint">]) => {
  const value = N.uint(input).toVar();
  value.bitXorAssign(value.shiftRight(16));
  value.mulAssign(N.uint(0x7feb352d));
  value.bitXorAssign(value.shiftRight(15));
  value.mulAssign(N.uint(0x846ca68b));
  value.bitXorAssign(value.shiftRight(16));
  return value;
});

function createSplatFragment({
  sorted,
  minAlpha,
  stochastic,
  stochasticResolve,
  stochasticNoise,
  temporalSample,
  depthOnly,
  premultipliedAlpha,
  composite,
}: {
  sorted: boolean;
  minAlpha: Node<"float">;
  stochastic: Node<"bool">;
  stochasticResolve: Node<"bool">;
  stochasticNoise: TextureNode<"uvec4">;
  temporalSample: Node<"vec4">;
  depthOnly: Node<"bool">;
  premultipliedAlpha: Node<"bool">;
  composite?: LayeredComposite;
}) {
  // Per-Splat constants share one flat varying: RGB and kernel power as
  // halves, alpha and squared support radius as float32 bits. See packSplatVarying.
  const vSplat = N.varyingProperty("uvec4", "gslSplat");
  const vSplatUv = N.varyingProperty("vec2", "gslSplatUv");
  const vStochasticHash = N.varyingProperty("uint", "gslStochasticHash");
  const vViewportOrigin = N.varyingProperty("vec2", "gslViewportOrigin");

  const splatColor = () => {
    const z2 = vSplatUv.dot(vSplatUv);
    z2.greaterThan(N.uintBitsToFloat(vSplat.w)).discard();
    const blueKernelPower = N.unpackHalf2x16(vSplat.y);
    const kernelPower = blueKernelPower.y;
    const kernelAlpha = z2.mul(-0.5).exp().toVar();
    N.If(kernelPower.notEqual(0), () => {
      kernelAlpha.assign(
        N.float(1).sub(N.float(1).sub(kernelAlpha).pow(kernelPower)),
      );
    });
    const alpha = N.uintBitsToFloat(vSplat.z).mul(kernelAlpha).toVar();
    alpha.lessThan(minAlpha).discard();
    // Auto, stochastic and depth draws keep the uniform graph.
    if (!sorted) {
      N.If(stochastic.or(depthOnly), () => {
        const pixel = N.uvec2(N.screenCoordinate.xy.sub(vViewportOrigin));
        // Match the fixed per-Splat coverage used by the WebGL color/depth pass.
        const offset = N.uvec2(
          vStochasticHash,
          vStochasticHash.shiftRight(5),
        ).add(
          N.select(
            stochastic.and(depthOnly.not()),
            N.uvec2(temporalSample.zw),
            N.uvec2(0),
          ),
        );
        const coord = N.ivec2(
          pixel.x.add(offset.x).bitAnd(31),
          pixel.y.add(offset.y).bitAnd(31),
        );
        const randomValue = N.float(load2D(stochasticNoise, coord).r)
          .add(0.5)
          .div(1024);
        randomValue.greaterThanEqual(alpha).discard();
      });
    }
    // Decode color only after the fragment survives coverage tests.
    const rgba = N.vec4(
      N.unpackHalf2x16(vSplat.x),
      blueKernelPower.x,
      alpha,
    ).toVar();
    if (sorted) return rgba;
    N.If(stochastic.and(depthOnly.not()), () => {
      // NodeMaterial premultiplies its output when requested. Cancel the
      // alpha-2 marker here so the stored stochastic RGB remains straight.
      N.If(premultipliedAlpha.and(stochasticResolve), () => {
        rgba.rgb.mulAssign(0.5);
      });
      rgba.a.assign(N.select(stochasticResolve, 2, 1));
    });
    return rgba;
  };

  const fragmentNode = N.Fn(() => {
    if (!composite) return splatColor();
    const color = N.vec4(0).toVar();
    N.If(composite.active, () => {
      const layers = load2D(composite.layers, N.ivec2(N.screenCoordinate.xy));
      const coverage = N.float(1).sub(layers.a).toVar();
      coverage.lessThanEqual(0).discard();
      // Emit the coverage-weighted mean color. Either sorted blend mode then
      // adds the accumulated premultiplied RGB over the remaining destination.
      color.assign(N.vec4(layers.rgb.div(coverage), coverage));
    }).Else(() => {
      color.assign(splatColor());
    });
    return color;
  })();

  return {
    vSplat,
    vSplatUv,
    vStochasticHash,
    vViewportOrigin,
    fragmentNode,
  };
}

// Half RGB saturates at its largest finite value instead of overflowing after
// sRGB linearization. Source alpha keeps float32 bits, but half kernel power
// can still change the final coverage of wide kernels.
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

export function createSplatNodeMaterial({
  uniforms,
  orderingNode: providedOrderingNode,
  vertexData,
  premultipliedAlpha,
  transparent,
  depthTest,
  depthWrite,
  sorted = false,
  vertexNode: sharedVertexNode,
  composite,
  batch,
}: {
  uniforms: Uniforms;
  orderingNode?: OrderingNode;
  vertexData?: (camera: THREE.Camera) => ProjectedVertexData;
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  sorted?: boolean;
  vertexNode?: Node<"vec4">;
  composite?: LayeredComposite;
  /** Texture-ordered drawing of one layered batch. */
  batch?: LayeredBatch;
}): SplatNodeMaterial {
  const orderingNode = providedOrderingNode ?? createDefaultOrderingNode();
  const splats = textureBinding(uniforms, "splats", true);
  const splats2 = textureBinding(uniforms, "splats2", true);
  const stochasticSeeds = textureBinding(uniforms, "stochasticSeeds", true);
  const stochasticNoise = textureBinding(uniforms, "stochasticNoise");
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
  const encodeLinear = uniformBinding(uniforms, "encodeLinear", "bool");
  const premultipliedAlphaNode = uniformBinding(
    uniforms,
    "premultipliedAlpha",
    "bool",
  );
  const stochastic = uniformBinding(uniforms, "stochastic", "bool");
  const temporalSample = uniformBinding(
    uniforms,
    "stochasticTemporalSample",
    "vec4",
  );
  const stochasticResolve = uniformBinding(
    uniforms,
    "stochasticResolve",
    "bool",
  );
  const depthOnly = uniformBinding(uniforms, "depthOnly", "bool");
  const { vSplat, vSplatUv, vStochasticHash, vViewportOrigin, fragmentNode } =
    createSplatFragment({
      sorted,
      minAlpha,
      stochastic,
      stochasticResolve,
      stochasticNoise,
      temporalSample,
      depthOnly,
      premultipliedAlpha: premultipliedAlphaNode,
      composite,
    });

  function buildVertex(builder: NodeBuilder) {
    const camera = materialCamera(builder);
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vSplat.assign(N.uvec4(0));
    vSplatUv.assign(N.vec2(0));
    vStochasticHash.assign(N.uint(0));

    const assignVertexData = (data: ProjectedVertexData) => {
      const rgba = data.rgba.toVar();
      // RGB is constant across the quad; decode its color space once
      // per vertex rather than for every covered fragment.
      N.If(encodeLinear.and(depthOnly.not()), () => {
        rgba.rgb.assign(N.sRGBTransferEOTF(rgba.rgb));
      });
      clipPosition.assign(data.clipPosition);
      vSplat.assign(
        packSplatVarying(rgba, data.supportRadiusSquared, data.kernelPower),
      );
      vSplatUv.assign(data.splatUv);
      // Coverage uses the same hash across every fragment of this Splat.
      N.If(stochastic.or(depthOnly), () => {
        vStochasticHash.assign(stochasticHash(data.stochasticSeed));
      });
      vViewportOrigin.assign(data.viewportOrigin);
    };

    if (vertexData) {
      assignVertexData(vertexData(camera));
    } else {
      const view = splatViewUniforms(uniforms, camera);
      vViewportOrigin.assign(view.viewportOrigin);
      const project = createProjectionProgram(uniforms, {
        ...view,
        projectionMatrix: N.cameraProjectionMatrix,
      });
      const index = N.uint(N.instanceIndex)
        .mul(SPLATS_PER_INSTANCE)
        .add(N.uint(N.positionGeometry.z))
        .toVar();
      const splatIndex = N.uint(0xffffffff).toVar();
      const splatCount = uniformBinding(uniforms, "splatCount", "uint");
      const stochasticOrdering = uniformBinding(
        uniforms,
        "stochasticOrdering",
        "bool",
      );
      const orderedIndex = (rank: Node<"uint">) => {
        if (!("isTextureNode" in orderingNode)) {
          return orderingNode.element(rank);
        }
        const texel = rank.shiftRight(2);
        const coord = N.ivec2(
          texel.mod(ORDERING_TEXTURE_WIDTH),
          texel.div(N.uint(ORDERING_TEXTURE_WIDTH)),
        );
        return load2D(orderingNode, coord).element(rank.bitAnd(3));
      };
      if (batch) {
        N.If(index.lessThan(batch.count), () => {
          // Walk the back-to-front order in reverse from the batch's first rank.
          splatIndex.assign(
            orderedIndex(splatCount.sub(batch.first.add(index)).sub(1)),
          );
        });
      } else {
        N.If(index.lessThan(splatCount), () => {
          splatIndex.assign(index);
          N.If(
            depthOnly.not().and(stochastic.not().or(stochasticOrdering)),
            () => {
              splatIndex.assign(orderedIndex(index));
            },
          );
        });
      }

      N.If(splatIndex.notEqual(N.uint(0xffffffff)), () => {
        const texCoord = splatTexCoord(splatIndex);
        const projected = project({
          first: loadArray(splats, texCoord),
          second: loadArray(splats2, texCoord),
        });
        N.If(projected.valid, () => {
          const stochasticSeed = N.uint(0).toVar();
          N.If(stochastic.or(depthOnly), () => {
            stochasticSeed.assign(loadArray(stochasticSeeds, texCoord).r);
          });
          const ndcOffset = projected.axis1
            .mul(N.positionGeometry.x)
            .add(projected.axis2.mul(N.positionGeometry.y));
          const ndcCenter = projected.clipCenter.xyz.div(
            projected.clipCenter.w,
          );
          assignVertexData({
            clipPosition: N.vec4(
              ndcCenter.xy.add(ndcOffset).mul(projected.clipCenter.w),
              projected.clipCenter.zw,
            ),
            rgba: projected.rgba,
            splatUv: N.positionGeometry.xy.mul(projected.supportRadius),
            stochasticSeed,
            supportRadiusSquared: projected.supportRadius.mul(
              projected.supportRadius,
            ),
            kernelPower: projected.kernelPower,
            viewportOrigin: view.viewportOrigin,
          });
        });
      });
    }

    N.If(stochastic.and(depthOnly.not()), () => {
      clipPosition.xy.addAssign(temporalSample.xy.mul(clipPosition.w));
    });
    if (composite) {
      N.If(composite.active, () => {
        // Composite draws cover the viewport with the first quad. Reflecting Y
        // keeps its local winding front-facing without the covariance basis.
        clipPosition.assign(
          N.vec4(N.positionGeometry.x, N.positionGeometry.y.negate(), 0.5, 1),
        );
      });
    }
    return clipPosition;
  }

  const vertexNode = sharedVertexNode ?? N.Fn(buildVertex)();

  return Object.assign(new NodeMaterial(), {
    uniforms,
    orderingNode,
    vertexNode,
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
