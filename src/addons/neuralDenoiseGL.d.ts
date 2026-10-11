import type { Texture, WebGLRenderer } from "three";
import type { WebGPURenderer } from "three/webgpu";
import { NeuralDenoisePasses } from "./neuralDenoisePasses.js";
import type { NeuralDenoiseModel } from "./neuralDenoiseWeights.js";
/** Executes the shared denoiser on either Three.js WebGL2 renderer. */
export declare class WebGLDenoisePasses extends NeuralDenoisePasses {
  constructor(
    renderer: WebGLRenderer | WebGPURenderer,
    model: NeuralDenoiseModel,
  );
  result: Texture;
  render(
    width: number,
    height: number,
    external: {
      color: Texture;
      depth: Texture;
      exposed: Texture | null;
      history: null;
      encode: boolean;
    },
    previous: number,
  ): void;
  dispose(): void;
}
