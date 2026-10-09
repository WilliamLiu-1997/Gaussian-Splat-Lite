import type {
  DepthTexture,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
} from "three";
import { Node, type NodeBuilder, type NodeFrame } from "three/webgpu";
/** Camera/depth TAA for WebGPURenderer, including its WebGL2 fallback. */
export declare class TAANode extends Node<"vec4"> {
  scene: Scene;
  camera: PerspectiveCamera | OrthographicCamera;
  static get type(): string;
  depthThreshold: number;
  edgeDepthDiff: number;
  maxMotionLength: number;
  useSubpixelCorrection: boolean;
  private readonly source;
  private readonly history;
  private readonly historyColor;
  private readonly historyDepth;
  private readonly textureNode;
  private readonly material;
  private readonly quad;
  private readonly state;
  private readonly zeroToOne;
  private readonly drawingSize;
  private workingColorSpace;
  private readonly pipelineStates;
  private pipelineRendering;
  private capturePending;
  constructor(scene: Scene, camera: PerspectiveCamera | OrthographicCamera);
  private makeTarget;
  get depthTexture(): DepthTexture;
  get projectionMatrix(): Matrix4;
  getTextureNode(): import("three/webgpu").TextureNode;
  setSize(width: number, height: number): void;
  reset(): void;
  updateBefore(frame: NodeFrame): undefined;
  setup(builder: NodeBuilder): import("three/webgpu").TextureNode;
  dispose(): void;
}
