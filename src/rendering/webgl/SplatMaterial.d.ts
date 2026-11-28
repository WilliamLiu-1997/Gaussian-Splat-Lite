import type * as THREE from "three";
import type { SplatModifier } from "../SplatModifier.js";
import type { SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
/** Sorted and stochastic variants keep separate programs. */
export declare function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  stochastic: boolean,
  modifier?: SplatModifier | null,
): THREE.ShaderMaterial;
