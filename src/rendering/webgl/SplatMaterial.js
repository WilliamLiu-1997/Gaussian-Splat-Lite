import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { getShaders } from "./shaders.js";
/** Sorted and stochastic variants keep separate programs. */
export function createWebGLSplatMaterial(uniforms, options, stochastic) {
  const shaders = getShaders();
  return new THREE.ShaderMaterial({
    ...options,
    defines: {
      SPLATS_PER_INSTANCE,
      GSL_STOCHASTIC: Number(stochastic),
    },
    glslVersion: THREE.GLSL3,
    vertexShader: shaders.splatVertex,
    fragmentShader: shaders.splatFragment,
    uniforms,
    side: THREE.FrontSide,
    allowOverride: false,
  });
}
