import type { WebGPURenderer } from "three/webgpu";
import type { AccumulatorRenderOptions } from "../webgl/AccumulatorGenerator.js";
/**
 * Rasterizes Splat records, and for stochastic targets stable sampling seeds,
 * into integer arrays.
 */
export declare class WebGLFallbackAccumulatorGenerator {
  readonly uniforms: import("../uniforms.js").Uniforms;
  private readonly material;
  private readonly quad;
  constructor(stochasticSeeds: boolean);
  generate(options: AccumulatorRenderOptions<WebGPURenderer>): void;
  dispose(): void;
}
