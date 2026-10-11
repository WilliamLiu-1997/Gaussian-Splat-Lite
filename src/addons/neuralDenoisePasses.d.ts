import type { NeuralDenoiseModel } from "./neuralDenoiseWeights.js";
/** Shared pass order and state layout for the two graphics APIs. */
export declare class NeuralDenoisePasses {
  uniforms: Float32Array;
  halfBias: number;
  protected initialize(
    model: NeuralDenoiseModel,
    multisampled: boolean,
  ): string;
}
export declare class WebGPUDenoisePasses extends NeuralDenoisePasses {
  constructor(device: object, model: NeuralDenoiseModel, multisampled: boolean);
  render(
    width: number,
    height: number,
    external: {
      color: object;
      depth: object;
      exposed: object | null;
      history: object[];
      encode: boolean;
    },
    previous: number,
  ): void;
  dispose(): void;
}
