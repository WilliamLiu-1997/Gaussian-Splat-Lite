import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import { SPLATS_PER_INSTANCE } from "../../rendering/SplatGeometry";
import { createGenerateProgram } from "../../rendering/tsl/GenerateProgram";
import { createProjectionProgram } from "../../rendering/tsl/ProjectionProgram";
import {
  createSplatFragment,
  packSplatVarying,
  stochasticHash,
} from "../../rendering/tsl/SplatMaterial";
import {
  N,
  textureBinding,
  uniformBinding,
} from "../../rendering/tsl/shaderUtils";
import type { Uniforms } from "../../rendering/uniforms";
import { getShaders } from "../../rendering/webgl/shaders";
import { poplessClipPosition } from "./tsl/poplessDepth";
import { depthPlaneProjection } from "./tsl/projection";
import shadowFragment from "./webgl/shadowFragment.glsl";
import shadowVertex from "./webgl/shadowVertex.glsl";

/**
 * Shadow-map draw of one model's source records: no
 * accumulator, ordering or per-light projection cache. Coverage is the
 * stochastic draw's, and depth follows each Gaussian's Popless plane.
 */
export function createShadowMaterial(
  uniforms: Uniforms,
  node: boolean,
  logarithmicDepthBuffer: boolean,
  colorWrite: boolean,
): THREE.Material {
  if (!node) {
    getShaders();
    return new THREE.ShaderMaterial({
      uniforms,
      defines: { SPLATS_PER_INSTANCE },
      glslVersion: THREE.GLSL3,
      vertexShader: shadowVertex,
      fragmentShader: shadowFragment,
      blending: THREE.NoBlending,
      colorWrite: false,
      side: THREE.DoubleSide,
      allowOverride: false,
      toneMapped: false,
    });
  }

  const placeholders: THREE.Texture[] = [];
  const fragment = createSplatFragment(
    uniformBinding(uniforms, "minAlpha", "float"),
    uniformBinding(uniforms, "edgeFade", "vec2"),
    textureBinding(uniforms, "stochasticNoise", placeholders),
    N.vec4(0, 0, 0, 1),
  );
  const { vSplat, vSplatUv, vStochasticOffset } = fragment;
  const generate = createGenerateProgram({ uniforms, placeholders });
  // The shadow camera is the render camera of its pass.
  const project = createProjectionProgram(
    uniforms,
    {
      projectionMatrix: N.cameraProjectionMatrix,
      renderToViewQuat: uniformBinding(uniforms, "renderToViewQuat", "vec4"),
      renderToViewPos: uniformBinding(uniforms, "renderToViewPos", "vec3"),
      renderToViewScale: uniformBinding(uniforms, "renderToViewScale", "float"),
      near: N.cameraNear,
      far: N.cameraFar,
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
    },
    depthPlaneProjection,
  );
  // Clip depth and reciprocal view depth on the plane; both are affine
  // across the quad.
  const vDepth = logarithmicDepthBuffer
    ? N.varyingProperty("vec2", "gslShadowDepth")
    : null;

  const material = new NodeMaterial();
  material.vertexNode = N.Fn(() => {
    const clipPosition = N.vec4(0, 0, 2, 1).toVar();
    vSplat.assign(N.uvec4(0));
    vSplatUv.assign(N.vec2(0));
    vStochasticOffset?.assign(N.uint(0));
    const index = N.uint(N.instanceIndex)
      .mul(SPLATS_PER_INSTANCE)
      .add(N.uint(N.positionGeometry.z));
    const splat = generate.prepare(index);
    const projected = project(splat, false);
    N.If(projected.valid, () => {
      const corner = N.positionGeometry.xy;
      const center = projected.clipCenter;
      const offset = projected.axis1
        .mul(corner.x)
        .add(projected.axis2.mul(corner.y));
      const shift = projected.extra.dot(corner).toVar();
      clipPosition.assign(
        poplessClipPosition(
          N.vec4(center.xy.add(offset.mul(center.w)), center.zw),
          shift,
        ),
      );
      vSplat.assign(
        packSplatVarying(
          projected.rgba,
          projected.supportRadiusSquared,
          projected.kernelPower,
        ),
      );
      vSplatUv.assign(corner.mul(projected.supportRadius));
      // One fixed slice of the noise atlas per Splat: a shadow's grain does
      // not flicker with the color pass's temporal sample.
      vStochasticOffset?.assign(
        stochasticHash(splat.stochasticSeed).bitAnd(0x7fff),
      );
      vDepth?.assign(
        N.vec2(
          clipPosition.z.div(clipPosition.w),
          N.float(1).add(shift).div(clipPosition.w),
        ),
      );
    });
    return clipPosition;
  })();
  material.colorNode = fragment.fragmentNode;
  if (vDepth) {
    material.depthNode = N.Fn((builder) => {
      const planeDepth =
        builder.renderer.coordinateSystem === THREE.WebGPUCoordinateSystem
          ? vDepth.x
          : vDepth.x.mul(0.5).add(0.5);
      return N.select(
        N.cameraProjectionMatrix.element(2).w.equal(0),
        planeDepth,
        N.viewZToLogarithmicDepth(
          vDepth.y.max(1e-20).reciprocal().negate(),
          N.cameraNear,
          N.cameraFar,
        ),
      );
    })();
  }
  // Shadow passes draw this material itself, not their override material.
  material.allowOverride = false;
  material.blending = THREE.NoBlending;
  material.colorWrite = colorWrite;
  material.side = THREE.DoubleSide;
  material.fog = false;
  material.toneMapped = false;
  material.addEventListener("dispose", () => {
    for (const texture of placeholders) texture.dispose();
  });
  return material;
}
