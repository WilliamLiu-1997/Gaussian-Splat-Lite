import * as THREE from "three";
import * as TSL from "three/tsl";
import { NodeMaterial, StorageBufferAttribute } from "three/webgpu";
import { ORDERING_TEXTURE_WIDTH, type Uniforms } from "../uniforms";
import { createProjectionProgram } from "./ProjectionProgram";
import {
  type TSLNode,
  load2D,
  loadArray,
  splatTexCoord,
  textureBinding,
  uniformBinding,
} from "./shaderUtils";
import { splatViewUniforms } from "./viewUniforms";

export type ProjectedVertexData = {
  clipPosition: TSLNode;
  /** Source color space; this material applies encodeLinear. */
  rgba: TSLNode;
  splatUv: TSLNode;
  stochasticSeed: TSLNode;
  supportRadiusSquared: TSLNode;
  kernelPower: TSLNode;
  viewportOrigin: TSLNode;
};

export type SplatNodeMaterial = NodeMaterial & {
  uniforms: Uniforms;
  orderingNode: TSLNode;
};

const N = TSL as Record<string, TSLNode>;

function createDefaultOrderingNode() {
  const ordering = new StorageBufferAttribute(new Uint32Array([0xffffffff]), 1);
  ordering.name = "GaussianSplatOrdering";
  return N.storage(ordering, "uint").toReadOnly();
}

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
  const vStochasticSeed = N.varyingProperty("uint", "gslStochasticSeed");
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
          .bitXor(vStochasticSeed.add(1).mul(N.uint(26699))),
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
    vStochasticSeed,
    vSupportRadiusSquared,
    vKernelPower,
    vViewportOrigin,
    fragmentNode,
  };
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
  orderingNode?: TSLNode;
  vertexData?: (camera: THREE.Camera) => ProjectedVertexData;
  premultipliedAlpha: boolean;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
}): SplatNodeMaterial {
  const orderingNode = providedOrderingNode ?? createDefaultOrderingNode();
  const splats = textureBinding(uniforms, "splats", true);
  const splats2 = textureBinding(uniforms, "splats2", true);
  const stochasticSeeds = textureBinding(uniforms, "stochasticSeeds", true);
  const minAlpha = uniformBinding(uniforms, "minAlpha", "float");
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
    vStochasticSeed,
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
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vRgba.assign(N.vec4(0));
    vSplatUv.assign(N.vec2(0));
    vStochasticSeed.assign(N.uint(0));
    vSupportRadiusSquared.assign(0);
    vKernelPower.assign(0);

    const assignVertexData = (data: ProjectedVertexData) => {
      const rgba = data.rgba.toVar();
      // RGB is constant across the quad; decode its color space once
      // per vertex rather than for every covered fragment.
      N.If(encodeLinear.and(depthOnly.not()), () => {
        rgba.rgb.assign(rgba.rgb.pow(2.2));
      });
      clipPosition.assign(data.clipPosition);
      vRgba.assign(rgba);
      vSplatUv.assign(data.splatUv);
      vStochasticSeed.assign(data.stochasticSeed);
      vSupportRadiusSquared.assign(data.supportRadiusSquared);
      vKernelPower.assign(data.kernelPower);
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
      const splatIndex = N.uint(N.instanceIndex).toVar();
      N.If(stochastic.or(depthOnly).not(), () => {
        const index = N.uint(N.instanceIndex);
        if (orderingNode.isTextureNode) {
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
