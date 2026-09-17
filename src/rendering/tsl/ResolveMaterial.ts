import * as THREE from "three";
import type { Node } from "three/webgpu";
import { NodeMaterial } from "three/webgpu";
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

export function createNodeResolveMaterial(state: ResolveState) {
  const source = N.textureLoad(state.sourceTexture.value).onObjectUpdate(
    () => state.sourceTexture.value,
  );
  const resolve = N.uniform(false, "bool").onObjectUpdate(
    () => state.resolve.value,
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
    const result = N.vec4(0).toVar();
    const copySource = () => {
      result.assign(physicalSource(load(sourceCoord)));
    };

    N.If(resolve, () => {
      const u = N.vec2(sourceCoord).sub(0.5).mul(0.5);
      const quad = u.floor();
      const fraction = u.sub(quad);
      const base = N.ivec2(quad).mul(2);
      const nearWeights = N.vec2(1).sub(fraction).mul(0.5);
      const farWeights = fraction.mul(0.5);
      const hasSplat = N.bool(false).toVar();
      const accumulated = N.vec4(0).toVar();

      for (let y = 0; y < 4; y += 1) {
        const weightY = y < 2 ? nearWeights.y : farWeights.y;
        for (let x = 0; x < 4; x += 1) {
          const weightX = x < 2 ? nearWeights.x : farWeights.x;
          const weight = weightX.mul(weightY);
          const sourceTexel = load(base.add(N.ivec2(x, y)));
          const texel = convertPremultiplied(sourceTexel, 1 / 2.2, perceptual);
          // Integer pixel coordinates give fractions of 1/4 or 3/4, so
          // every tap has positive weight; only marker presence matters.
          hasSplat.assign(hasSplat.or(sourceTexel.a.greaterThan(1)));
          accumulated.addAssign(texel.mul(weight));
        }
      }

      N.If(hasSplat, () => {
        result.assign(convertPremultiplied(accumulated, 2.2, perceptual));
      }).Else(copySource);
    }).Else(copySource);

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
  const depth = N.textureLoad(state.sourceDepth.value).onObjectUpdate(
    () => state.sourceDepth.value,
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
