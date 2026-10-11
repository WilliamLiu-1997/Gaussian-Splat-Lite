import type {
  DepthTexture,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
} from "three";
import { Node, type NodeBuilder, type NodeFrame } from "three/webgpu";
import type { NeuralDenoiseProfile } from "./neuralDenoiseWeights.js";
/**
 * Temporal neural denoiser for stochastic Splat rendering on WebGPURenderer,
 * including its WebGL2 fallback,
 * used in place of TAANode. After Hu et al., "Ultra-fast Neural Inference for
 * Stochastic Gaussian Splatting Denoising" (arXiv 2609.25604), adapted to
 * scenes whose objects move.
 */
export declare class NeuralDenoiseNode extends Node<"vec4"> {
  scene: Scene;
  camera: PerspectiveCamera | OrthographicCamera;
  readonly profile: NeuralDenoiseProfile;
  readonly samples: 1 | 4;
  private readonly coverage;
  static get type(): string;
  /**
   * Blends the result with the previous image where the network trusts it.
   * Steadier; turn it off for the two history paths alone.
   */
  stabilize: boolean;
  private readonly source;
  private readonly history;
  private readonly textureNode;
  private readonly encoded;
  private readonly outputColor;
  private readonly state;
  private passes;
  private readonly depth;
  private depthRead;
  private readonly previousWorld;
  private readonly previousProjection;
  private readonly relative;
  /** Frames drawn, for the scene's place in its target. */
  private frame;
  private readonly toPreviousClip;
  private readonly drawingSize;
  private workingColorSpace;
  private readonly pipelineStates;
  private pipelineRendering;
  private capturePending;
  /**
   * @param profile Fixed filtering (`"profile1"`) or learned filtering
   *   (`"profile2"`, default). Fixed for the node's lifetime.
   * @param samples Coverage samples per pixel: 1 (default) or 4, with
   *   either profile. Fixed for the node's lifetime.
   */
  constructor(
    scene: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    profile?: NeuralDenoiseProfile,
    samples?: 1 | 4,
  );
  /** Scene depth of the current frame, kept from the first read on. */
  get depthTexture(): DepthTexture;
  /** The projection `depthTexture` was rendered with. */
  get projectionMatrix(): Matrix4;
  /** The denoised image, for chaining effects. */
  getTextureNode(): Node<"vec4">;
  setSize(width: number, height: number): void;
  /** Discards earlier frames, as after a camera cut. */
  reset(): void;
  updateBefore(frame: NodeFrame): undefined;
  setup(builder: NodeBuilder): Node<"vec4">;
  dispose(): void;
}
