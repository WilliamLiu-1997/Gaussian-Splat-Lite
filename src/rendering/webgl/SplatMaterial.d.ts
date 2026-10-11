import type * as THREE from "three";
import type { SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
/** Sorted and stochastic variants keep separate programs. */
export declare function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  stochastic: boolean,
): THREE.ShaderMaterial;
/** Shares the existing Splat shader and uniforms, adding four-sample coverage. */
export declare function createWebGLCoverageVariant(
  source: THREE.Material,
  renderer: THREE.WebGLRenderer,
): THREE.ShaderMaterial | null;
