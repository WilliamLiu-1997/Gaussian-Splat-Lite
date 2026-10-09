import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry.js";
import { getShaders } from "./shaders.js";
export function createWebGLSplatMaterial(uniforms, options) {
  const shaders = getShaders();
  return new THREE.ShaderMaterial({
    ...options,
    defines: {
      SPLATS_PER_INSTANCE,
      GSL_STOCHASTIC: 0,
    },
    glslVersion: THREE.GLSL3,
    vertexShader: shaders.splatVertex,
    fragmentShader: shaders.splatFragment,
    uniforms,
    side: THREE.FrontSide,
    allowOverride: false,
  });
}
