import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { getShaders } from "./shaders.js";
/**
 * Sorted and stochastic variants keep separate programs. `shading` may
 * recolor each Splat in the vertex stage: its GLSL fills the vertex shader's
 * two shading includes.
 */
export function createWebGLSplatMaterial(
  uniforms,
  options,
  stochastic,
  shading,
) {
  const shaders = getShaders();
  return new THREE.ShaderMaterial({
    ...options,
    defines: {
      SPLATS_PER_INSTANCE,
      GSL_STOCHASTIC: Number(stochastic),
    },
    glslVersion: THREE.GLSL3,
    vertexShader: shaders.splatVertex
      .replace("#include <splatShadingPars>", shading?.vertexPars ?? "")
      .replace("#include <splatShading>", shading?.vertex ?? ""),
    fragmentShader: shaders.splatFragment,
    uniforms: shading ? { ...uniforms, ...shading.uniforms } : uniforms,
    side: THREE.FrontSide,
    allowOverride: false,
  });
}
