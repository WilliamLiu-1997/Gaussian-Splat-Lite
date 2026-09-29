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
  stochasticNoise,
  temporalFrame,
  depthOnly,
}: {
  sorted: boolean;
  minAlpha: Node<"float">;
  stochastic: Node<"bool">;
  stochasticNoise: TextureNode<"uvec4">;
  temporalFrame: Node<"int">;
  depthOnly: Node<"bool">;
}) {
  // Per-Splat constants share one flat varying: RGB and kernel power as
  // halves, alpha and squared support radius as float32 bits. See packSplatVarying.
  const vSplat = N.varyingProperty("uvec4", "gslSplat");
  const vSplatUv = N.varyingProperty("vec2", "gslSplatUv");
  const vStochasticHash = N.varyingProperty("uint", "gslStochasticHash");
  const vViewportOrigin = N.varyingProperty("vec2", "gslViewportOrigin");

  const fragmentNode = N.Fn(() => {
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
        const offset = N.uvec2(vStochasticHash, vStochasticHash.shiftRight(5));
        const coord = N.ivec2(
          pixel.x.add(offset.x).bitAnd(31),
          pixel.y.add(offset.y).bitAnd(31),
        );
        const randomValue = N.float(load2D(stochasticNoise, coord).r)
          .add(0.5)
          .div(1024)
          .toVar();
        N.If(
          stochastic
            .and(depthOnly.not())
            .and(temporalFrame.greaterThanEqual(0)),
          () => {
            const quad = pixel.shiftRight(N.uvec2(1));
            const h = quad.x
              .mul(N.uint(1973))
              .bitXor(quad.y.mul(N.uint(9277)))
              .bitXor(vStochasticHash.mul(N.uint(26699)))
              .bitXor(N.uint(temporalFrame))
              .toVar();
            h.assign(h.bitXor(h.shiftRight(16)).mul(N.uint(0x7feb352d)));
            h.assign(h.bitXor(h.shiftRight(15)).mul(N.uint(0x846ca68b)));
            h.assign(h.bitXor(h.shiftRight(16)));
            const stratum = pixel.y
              .bitAnd(1)
              .mul(N.uint(2))
              .add(pixel.x.bitAnd(1))
              .bitXor(h.bitAnd(3));
            randomValue.assign(
              N.float(stratum)
                .add(N.float(h.shiftRight(8)).div(16777216))
                .mul(0.25),
            );
          },
        );
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
    // Accepted stochastic samples are opaque.
    N.If(stochastic.and(depthOnly.not()), () => {
      rgba.a.assign(1);
    });
    return rgba;
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
}): SplatNodeMaterial {
  const orderingNode = providedOrderingNode ?? createDefaultOrderingNode();
  const splats = textureBinding(uniforms, "splats", true);
  const splats2 = textureBinding(uniforms, "splats2", true);
  const stochasticSeeds = textureBinding(uniforms, "stochasticSeeds", true);
  const stochasticNoise = textureBinding(uniforms, "stochasticNoise");
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
  const encodeLinear = uniformBinding(uniforms, "encodeLinear", "bool");
  const stochastic = uniformBinding(uniforms, "stochastic", "bool");
  const temporalFrame = uniformBinding(
    uniforms,
    "stochasticTemporalFrame",
    "int",
  );
  const depthOnly = uniformBinding(uniforms, "depthOnly", "bool");
  const { vSplat, vSplatUv, vStochasticHash, vViewportOrigin, fragmentNode } =
    createSplatFragment({
      sorted,
      minAlpha,
      stochastic,
      stochasticNoise,
      temporalFrame,
      depthOnly,
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
      N.If(index.lessThan(splatCount), () => {
        splatIndex.assign(index);
        N.If(
          depthOnly.not().and(stochastic.not().or(stochasticOrdering)),
          () => {
            if ("isTextureNode" in orderingNode) {
              const texel = index.shiftRight(2);
              const coord = N.ivec2(
                texel.mod(ORDERING_TEXTURE_WIDTH),
                texel.div(N.uint(ORDERING_TEXTURE_WIDTH)),
              );
              splatIndex.assign(
                load2D(orderingNode, coord).element(index.bitAnd(3)),
              );
            } else {
              splatIndex.assign(orderingNode.element(index));
            }
          },
        );
      });

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
