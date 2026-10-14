import type {
  DepthTexture,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import { Pass } from "three/addons/postprocessing/Pass.js";
import type { NeuralDenoiseMode } from "./NeuralDenoiseNode.js";
/** Experimental neural denoising for WebGLRenderer. Use with EffectComposer and OutputPass. */
export declare class NeuralDenoisePass extends Pass {
  private readonly denoise;
  private readonly copy;
  private readonly quad;
  constructor(
    scene: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    mode?: NeuralDenoiseMode,
    msaa?: boolean,
  );
  scene: Scene;
  camera: PerspectiveCamera | OrthographicCamera;
  readonly mode: NeuralDenoiseMode;
  readonly msaa: boolean;
  stabilize: boolean;
  readonly depthTexture: DepthTexture;
  readonly projectionMatrix: Matrix4;
  setSize(width: number, height: number): void;
  reset(): void;
  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget): void;
  dispose(): void;
}
