/** One layer: weights in PyTorch's order (output, input, row, column), then biases. */
export type NeuralDenoiseLayer = {
  w: number[];
  b: number[];
};
/** Which trained model NeuralDenoiseNode runs. */
export type NeuralDenoiseQuality = "performance" | "balanced";
/**
 * A trained model behind NeuralDenoiseNode: the trust network, the spatial
 * kernel's radius and the gate's gain, with the constants it was trained
 * under. Trained on this renderer's stochastic frames.
 */
export type NeuralDenoiseModel = {
  /** Radius of the spatial kernel in pixels. */
  blur: number;
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
   * image fast, the denoised path takes a wider filter's result in place of
   * the filtered frame: the learned filter's half-resolution result, or
   * without one the frame's mean over 4x4 pixels.
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
  sparseWide: boolean;
  /**
   * Set on a model that follows motion measured from the images: the rates of
   * the running means of the motion estimate and of the share of the frame
   * difference it explains, the damping of the least-squares fit, how often
   * its sums are halved to form the window, the predicted probabilities
   * below which the estimate is not followed and above which it is followed
   * fully, the same pair for the share of the difference the estimate has
   * been explaining, and the weight, as a share of the damping, that holds
   * the estimate towards no motion. `network` gives the probability: four
   * inputs, eight hidden channels, one output.
   */
  follow?: {
    rate: number;
    shareRate: number;
    damping: number;
    pools: number;
    threshold: [number, number];
    explained: [number, number];
    prior: number;
    network: {
      hidden: NeuralDenoiseLayer;
      out: NeuralDenoiseLayer;
    };
  };
  /**
   * Set on a model with a learned spatial filter, which takes the fixed
   * kernel's place: a 3x3 kernel predicted for every pixel at each level of
   * the frame's image pyramid, coarsest first, and then at full resolution.
   * `levels[0]` is the half-resolution level. A level's `encode` takes its
   * colour, the result of the level below, the noise at its scale and the
   * hidden channels of the level below (the last level has no level below);
   * `head`, and `top` at full resolution, give the nine kernel weights and
   * the share of the filtered image to keep over the level below.
   */
  filter?: {
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
export declare const neuralDenoiseModels: Record<
  NeuralDenoiseQuality,
  NeuralDenoiseModel
>;
