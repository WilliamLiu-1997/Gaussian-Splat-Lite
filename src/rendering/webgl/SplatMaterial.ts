import * as THREE from "three";
import type { SplatMaterialOptions } from "../backend";
import type { Uniforms } from "../uniforms";
import { getShaders } from "./shaders";

export function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
) {
  const shaders = getShaders();
  const defines: Record<string, number> = {};
  if (
    options.vertexShader === undefined &&
    options.fragmentShader === undefined
  ) {
    defines.GSL_COLOR_IN_VERTEX = 1;
  }
  return new THREE.ShaderMaterial({
    ...options,
    defines,
    glslVersion: THREE.GLSL3,
    vertexShader: options.vertexShader ?? shaders.splatVertex,
    fragmentShader: options.fragmentShader ?? shaders.splatFragment,
    uniforms,
    side: THREE.FrontSide,
    allowOverride: false,
  });
}
