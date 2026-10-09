import type * as THREE from "three";
import type { SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
export declare function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
): THREE.ShaderMaterial;
