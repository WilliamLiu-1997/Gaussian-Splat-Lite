import type { WebGPURenderer } from "three/webgpu";
import type { SplatModifier } from "../SplatModifier.js";
import type { Uniforms } from "../uniforms.js";
import type { AccumulatorRenderOptions } from "../webgl/AccumulatorGenerator.js";

/**
 * Rasterizes Splat records, and for stochastic targets stable sampling seeds,
 * into integer arrays.
 */
export declare class WebGLFallbackAccumulatorGenerator {
  readonly uniforms: Uniforms;
  private readonly material;
  private readonly quad;
  constructor(
    stochasticSeeds: boolean,
    modifierData?: boolean,
    modifier?: SplatModifier | null,
  );
  generate(options: AccumulatorRenderOptions<WebGPURenderer>): void;
  dispose(): void;
}
