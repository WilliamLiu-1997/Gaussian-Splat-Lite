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
  supportRadiusSquared: Node<"float">;
  kernelPower: Node<"float">;
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

function createSplatFragment(minAlpha: Node<"float">) {
  // Per-Splat constants share one flat varying: RGB and kernel power as
  // halves, alpha and squared support radius as float32 bits. See packSplatVarying.
  const vSplat = N.varyingProperty("uvec4", "gslSplat");
  const vSplatUv = N.varyingProperty("vec2", "gslSplatUv");

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
    // Decode color only after the fragment survives coverage tests.
    const rgba = N.vec4(
      N.unpackHalf2x16(vSplat.x),
      blueKernelPower.x,
      alpha,
    ).toVar();
    return rgba;
  })();

  return {
    vSplat,
    vSplatUv,
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
}: {
  uniforms: Uniforms;
  orderingNode?: OrderingNode;
  vertexData?: (camera: THREE.Camera) => ProjectedVertexData;
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
}): SplatNodeMaterial {
  const orderingNode = providedOrderingNode ?? createDefaultOrderingNode();
  const splats = textureBinding(uniforms, "splats", true);
  const splats2 = textureBinding(uniforms, "splats2", true);
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
  const encodeLinear = uniformBinding(uniforms, "encodeLinear", "bool");
  const { vSplat, vSplatUv, fragmentNode } = createSplatFragment(minAlpha);

  function buildVertex(builder: NodeBuilder) {
    const camera = materialCamera(builder);
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vSplat.assign(N.uvec4(0));
    vSplatUv.assign(N.vec2(0));

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
    };

    if (vertexData) {
      assignVertexData(vertexData(camera));
    } else {
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
      const splatCount = uniformBinding(uniforms, "splatCount", "uint");
      N.If(index.lessThan(splatCount), () => {
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
      });

      N.If(splatIndex.notEqual(N.uint(0xffffffff)), () => {
        const texCoord = splatTexCoord(splatIndex);
        const projected = project({
          first: loadArray(splats, texCoord),
          second: loadArray(splats2, texCoord),
        });
        N.If(projected.valid, () => {
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
            supportRadiusSquared: projected.supportRadius.mul(
              projected.supportRadius,
            ),
            kernelPower: projected.kernelPower,
          });
        });
      });
    }

    return clipPosition;
  }

  const vertexNode = N.Fn(buildVertex)();

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
