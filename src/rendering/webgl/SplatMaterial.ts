import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "../SplatGeometry";
import type { SplatMaterialOptions } from "../backend";
import type { Uniforms } from "../uniforms";
import { getShaders } from "./shaders";

export function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
) {
  const shaders = getShaders();
  return new THREE.ShaderMaterial({
    ...options,
    defines: {
      SPLATS_PER_INSTANCE,
      GSL_SORTED_FRAGMENT: 0,
    },
    glslVersion: THREE.GLSL3,
    vertexShader: shaders.splatVertex,
    fragmentShader: shaders.splatFragment,
    uniforms,
    side: THREE.FrontSide,
    allowOverride: false,
  });
}
