import type { NeuralDenoiseModel } from "./neuralDenoiseWeights.js";
/** Floats in the uniform block shared by every pass; see PARAMS below. */
export declare const NEURAL_DENOISE_UNIFORM_FLOATS = 68;
/**
 * The WGSL of every pass, with the trained weights written in as constants.
 * Each fragment shader's bindings are: the uniform block, a linear sampler,
 * then its textures in the order they are declared.
 *
 * The view depth is kept per 2x2 block. The network runs on 4x4 blocks, and
 * takes a block's means from a few bilinear taps straight into the previous
 * frame's state, so nothing reprojected has to be stored for it. One pass
 * per pixel then reprojects, filters, updates both paths, mixes them and
 * stabilizes the result. Motion following, where enabled, stays at half
 * resolution and predicts its own decision in the motion solve.
 */
export declare function neuralDenoiseShaders(weights: NeuralDenoiseModel): {
  cells: string;
  wider: string;
  depth: string;
  expose: string;
  frame: string;
  encode: string;
  downsample: string;
  features: string;
  stage: string;
  predict: string;
  resolve: string;
  rounding: string;
  lowLevel: number;
  filter:
    | {
        encode: string[];
        kernel: string[];
        top: string;
        groups: number;
      }
    | undefined;
  groups: number;
  follow: {
    motion: string;
    pool: string;
    solve: string;
    pools: number;
  } | null;
};
