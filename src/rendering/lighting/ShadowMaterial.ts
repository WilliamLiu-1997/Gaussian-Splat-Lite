import * as THREE from "three";
import { type Node, NodeMaterial } from "three/webgpu";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry";
import { createGenerateProgram } from "../tsl/GenerateProgram";
import { createProjectionProgram } from "../tsl/ProjectionProgram";
import { poplessClipPosition } from "../tsl/poplessDepth";
import { N, load2D, textureBinding, uniformBinding } from "../tsl/shaderUtils";
import type { Uniforms } from "../uniforms";
import { getShaders } from "../webgl/shaders";
import shadowFragment from "./shadowFragment.glsl";
import shadowVertex from "./shadowVertex.glsl";

const hash = N.Fn(([input]: [Node<"uint">]) => {
  const value = input.toVar();
  value.bitXorAssign(value.shiftRight(16));
  value.mulAssign(N.uint(0x7feb352d));
  value.bitXorAssign(value.shiftRight(15));
  value.mulAssign(N.uint(0x846ca68b));
  return value.bitXor(value.shiftRight(16));
});

/** Direct source draw with vertex Popless depth; no per-light projection cache. */
export function createShadowMaterial(
  uniforms: Uniforms,
  node: boolean,
  logarithmicDepthBuffer = false,
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
      side: THREE.FrontSide,
      toneMapped: false,
    });
  }
  const u = (name: string) => uniformBinding(uniforms, name, "float");
  const generate = createGenerateProgram({ uniforms });
  const project = createProjectionProgram(
    uniforms,
    {
      projectionMatrix: N.cameraProjectionMatrix,
      renderToViewQuat: uniformBinding(uniforms, "renderToViewQuat", "vec4"),
      renderToViewPos: uniformBinding(uniforms, "renderToViewPos", "vec3"),
      renderToViewScale: u("renderToViewScale"),
      near: N.cameraNear,
      far: N.cameraFar,
      renderSize: uniformBinding(uniforms, "renderSize", "vec2"),
    },
    true,
  );
  const uv = N.varyingProperty("vec2", "shadowUv");
  const kernel = N.varyingProperty("vec3", "shadowKernel");
  const seed = N.varyingProperty("uint", "shadowSeed");
  const depth = N.varyingProperty("vec2", "shadowDepth");
  const material = new NodeMaterial();
  material.vertexNode = N.Fn(() => {
    const result = N.vec4(0, 0, 2, 1).toVar();
    const index = N.attribute("shadowBlock", "uint").add(
      N.uint(N.positionGeometry.z),
    );
    const splat = generate.prepare(index);
    const projected = project(splat, false);
    N.If(projected.valid, () => {
      const offset = projected.axis1
        .mul(N.positionGeometry.x)
        .add(projected.axis2.mul(N.positionGeometry.y));
      const clip = projected.clipCenter.toVar();
      clip.xy.addAssign(offset.mul(clip.w));
      result.assign(poplessClipPosition(clip, projected.depthShift));
      uv.assign(N.positionGeometry.xy.mul(projected.supportRadius));
      kernel.assign(
        N.vec3(
          projected.rgba.a,
          projected.kernelPower,
          projected.supportRadius.mul(projected.supportRadius),
        ),
      );
      seed.assign(hash(splat.stochasticSeed));
      if (logarithmicDepthBuffer) {
        depth.assign(
          N.vec2(
            result.z.div(result.w),
            N.float(1)
              .add(projected.depthShift.dot(N.positionGeometry.xy))
              .div(result.w),
          ),
        );
      }
    });
    return result;
  })();
  const noise = textureBinding(uniforms, "stochasticNoise");
  const viewportOrigin = uniformBinding(uniforms, "viewportOrigin", "vec2");
  material.colorNode = N.Fn(() => {
    const r2 = uv.dot(uv);
    r2.greaterThan(kernel.z).discard();
    const coverage = r2.mul(-0.5).exp().toVar();
    N.If(kernel.y.greaterThan(0), () => {
      coverage.assign(N.float(1).sub(N.float(1).sub(coverage).pow(kernel.y)));
    });
    coverage.mulAssign(kernel.x);
    coverage.lessThan(u("minAlpha")).discard();
    const pixel = N.uvec2(N.screenCoordinate.xy.sub(viewportOrigin));
    const coord = N.ivec2(
      pixel.x.add(seed).bitAnd(31),
      pixel.y.add(seed.shiftRight(5)).bitAnd(31),
    );
    N.float(load2D(noise, coord).r)
      .add(0.5)
      .div(1024)
      .greaterThanEqual(coverage)
      .discard();
    return N.vec4(0, 0, 0, 1);
  })();
  if (logarithmicDepthBuffer) {
    material.depthNode = N.Fn((builder) => {
      const linear =
        builder.renderer.coordinateSystem === THREE.WebGPUCoordinateSystem
          ? depth.x
          : depth.x.mul(0.5).add(0.5);
      return N.select(
        N.cameraProjectionMatrix.element(2).w.equal(0),
        linear,
        N.viewZToLogarithmicDepth(
          depth.y.reciprocal().negate(),
          N.cameraNear,
          N.cameraFar,
        ),
      );
    })();
  }
  material.allowOverride = false;
  material.blending = THREE.NoBlending;
  material.colorWrite = false;
  material.side = THREE.FrontSide;
  material.fog = false;
  material.toneMapped = false;
  return material;
}
