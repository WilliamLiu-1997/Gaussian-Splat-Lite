import type * as THREE from "three";
import type { GaussianSplatCompatibleRenderer } from "../rendererUtils.js";
import type { Uniforms } from "../uniforms.js";
/** Sorted rendering needs no seed layer; stochastic draws read one per Splat. */
export declare function createWebGLAccumulatorTarget(
  width: number,
  height: number,
  depth: number,
  stochasticSeeds: boolean,
): THREE.WebGLArrayRenderTarget;
/** Whether an accumulator target stores stochastic sampling seeds. */
export declare function hasStochasticSeeds(
  target: THREE.WebGLArrayRenderTarget,
): boolean;
export declare function getWebGLGenerateUniforms(): Uniforms;
export declare function generateWebGLAccumulator(
  options: AccumulatorRenderOptions<THREE.WebGLRenderer>,
): void;
export type AccumulatorRenderOptions<
  Renderer extends
    GaussianSplatCompatibleRenderer = GaussianSplatCompatibleRenderer,
> = {
  renderer: Renderer;
  target: THREE.WebGLArrayRenderTarget;
  base: number;
  count: number;
};
/** Draw row-aligned ranges into array layers with either WebGL renderer API. */
export declare function renderAccumulatorLayers(
  { renderer, target, base, count }: AccumulatorRenderOptions,
  uniforms: Uniforms,
  draw: () => void,
): void;
