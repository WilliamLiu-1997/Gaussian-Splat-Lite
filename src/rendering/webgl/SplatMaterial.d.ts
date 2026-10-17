import type * as THREE from "three";
import type { SplatMaterialOptions } from "../backend.js";
import type { EffectBinding } from "../shader/EffectBinding.js";
import type { Uniforms } from "../uniforms.js";
/** Sorted and stochastic variants keep separate programs. */
export declare function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  stochastic: boolean,
  effect?: EffectBinding | null,
): THREE.ShaderMaterial;
