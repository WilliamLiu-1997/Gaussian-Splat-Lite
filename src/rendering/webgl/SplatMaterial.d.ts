import type * as THREE from "three";
import type { SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
/** GLSL that recolors each Splat in the vertex stage, where its color is constant. */
export type SplatShading = {
  uniforms?: Record<string, THREE.IUniform>;
  /** Declarations ahead of `main`. */
  vertexPars: string;
  /** Statements that update `rgba.rgb`, in the space the draw blends in. */
  vertex: string;
};
/**
 * Sorted and stochastic variants keep separate programs. `shading` may
 * recolor each Splat in the vertex stage: its GLSL fills the vertex shader's
 * two shading includes.
 */
export declare function createWebGLSplatMaterial(
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  stochastic: boolean,
  shading?: SplatShading,
): THREE.ShaderMaterial;
