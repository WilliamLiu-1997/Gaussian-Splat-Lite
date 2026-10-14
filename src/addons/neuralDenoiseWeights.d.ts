/** One layer: weights in PyTorch's order (output, input, row, column), then biases. */
export type NeuralDenoiseLayer = {
  w: number[];
  b: number[];
};
/**
 * A trained model behind NeuralDenoiseNode: the trust network, the spatial
 * filter and gate's gain, with the constants it was trained under.
 * Trained on this renderer's stochastic frames.
 */
export type NeuralDenoiseModel = {
  /** Use fixed local filtering without learned multiscale passes. */
  compact?: boolean;
  /** Strengthen display stabilization for single-sample stochastic noise. */
  stabilizeNoise?: boolean;
  /** Gain of the variance gate between the two history paths. */
  gamma: number;
  /** Longest history of the accumulated and of the denoised path, in frames. */
  accumulatedFrames: number;
  denoisedFrames: number;
  /** Frames after which the gate starts to prefer the accumulated path. */
  gateFrames: number;
  /** Screen motion in pixels at which the motion input reads one half. */
  motionKnee: number;
  /** Stabilization: the largest blend with the previous image, and the clamp's slack. */
  stabilizeBlend: number;
  stabilizeSlack: number;
  /** Lengths, in frames, of the four running means of the evidence that history lags. */
  evidenceFrames: number[];
  /**
   * The frames of denoised history under which, where the camera changes the
   * image fast, the denoised path takes the learned filter's half-resolution
   * result in place of the filtered frame.
   */
  reach: number;
  /**
   * The relative difference in view depth beyond which the place a pixel
   * reads its history from held another surface, whose history the pixel
   * then drops, and the camera motion, in pixels per frame, at which that
   * test has half its say: it is void on a still view.
   */
  surfaceApart: number;
  surfaceKnee: number;
  /** Share of rejected-surface fallback taken from the fixed 4x4 mean. */
  surfaceWide: number;
  /**
   * For a block where too little was drawn for a depth of its own: how many
   * drawn pixels a cell around it needs before it lends the block their
   * depth, how far their disparities may spread about their mean, the
   * accumulated history such a block keeps while the camera moves, in
   * frames, and the camera motion, in pixels per frame, at which that limit
   * has half its say. With `sparseWide` the block's denoised path takes the
   * wider filter's result while its own history is short.
   */
  lendLeast: number;
  lendSpread: number;
  sparseFrames: number;
  sparseKnee: number;
  /** Remaining display-history blend at full sparse camera motion. */
  sparseStabilize: number;
  sparseWide: boolean;
  /**
   * The learned spatial filter: a 3x3 kernel predicted at each level of
   * the frame's image pyramid, coarsest first, and then at full resolution.
   * `levels[0]` is the half-resolution level. A level's `encode` takes its
   * colour, the result of the level below, the noise at its scale and the
   * hidden channels of the level below (the last level has no level below);
   * `head`, and `top` at full resolution, give the nine kernel weights and
   * the share of the filtered image to keep over the level below.
   */
  filter: {
    /**
     * Set on a filter whose full-resolution kernel can leave a single sample
     * out: `top` then has two more inputs (how far the pixel is from the
     * half-resolution result in luma, signed and unsigned) and an eleventh
     * output, the rate at which a tap loses weight with its own distance from
     * that result. This is the scale of that rate.
     */
    robust?: number;
    levels: {
      encode: NeuralDenoiseLayer;
      depthwise: NeuralDenoiseLayer;
      pointwise: NeuralDenoiseLayer;
      head: NeuralDenoiseLayer;
    }[];
    top: NeuralDenoiseLayer;
  };
  /** Optional pixel-local logit correction: twelve inputs, four hidden channels, four outputs. */
  correction?: {
    hidden: NeuralDenoiseLayer;
    out: NeuralDenoiseLayer;
  };
  /**
   * 28 inputs to five outputs: trust in the accumulated history, the
   * stabilization blend, the accumulated path's share of the gate, the
   * strength of the spatial filter, and trust in the denoised history. The
   * hidden layers have 8 or 16 channels; `blocks` are extra residual blocks
   * between the two stages every model has.
   */
  network: {
    encode: NeuralDenoiseLayer;
    depthwise1: NeuralDenoiseLayer;
    pointwise1: NeuralDenoiseLayer;
    pointwise2: NeuralDenoiseLayer;
    blocks: {
      depthwise: NeuralDenoiseLayer;
      pointwise1: NeuralDenoiseLayer;
      pointwise2: NeuralDenoiseLayer;
    }[];
    depthwise2: NeuralDenoiseLayer;
    pointwise3: NeuralDenoiseLayer;
    head: NeuralDenoiseLayer;
  };
};
export declare const neuralDenoiseModels: {
  quality: NeuralDenoiseModel;
  performance: NeuralDenoiseModel;
};
