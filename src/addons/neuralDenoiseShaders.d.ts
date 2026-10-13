import type { NeuralDenoiseModel } from "./neuralDenoiseWeights.js";
/** Floats in the uniform block shared by every pass; see PARAMS below. */
export declare const NEURAL_DENOISE_UNIFORM_FLOATS = 68;
/**
 * The WGSL of every pass, with the trained weights written in as constants.
 * Each fragment shader's bindings are: the uniform block, a linear sampler,
 * then its textures in the order they are declared.
 *
 * Both modes keep view depth per 2x2 block. The network runs on 4x4 blocks,
 * followed by per-pixel reprojection, filtering, blending and stabilization.
 * Performance uses fixed local filtering and simpler history sampling;
 * Quality uses learned multiscale filtering.
 */
export declare function neuralDenoiseShaders(
  weights: NeuralDenoiseModel,
  multisampled?: boolean,
): NeuralDenoiseShaders;
type NeuralDenoiseShaders = {
  cells: string;
  wider: string;
  depth: string;
  expose: string;
  encode: string;
  downsample: string;
  features: string;
  stage: string;
  predict: string;
  resolve: string;
  rounding: string;
  filter: {
    encode: string[];
    kernel: string[];
    top: string;
    groups: number;
  };
  groups: number;
};
export {};
