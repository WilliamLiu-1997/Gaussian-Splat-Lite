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
/**
 * Temporal reprojection for WebGLRenderer, using depth and camera motion.
 * Object motion is not tracked; no velocity texture is required.
 * Owns scene capture, camera jitter, and history. It blends and accumulates
 * in the output color space, like direct canvas rendering, then hands the
 * composer a working-space result. Use EffectComposer with OutputPass for
 * output.
 */
export declare class TAAPass extends Pass {
  scene: Scene;
  camera: PerspectiveCamera | OrthographicCamera;
  /** Depth difference above which non-edge history is rejected. */
  depthThreshold: number;
  /** Depth range within the 3x3 neighborhood that identifies an edge. */
  edgeDepthDiff: number;
  /** Camera motion in pixels at which history loses all weight. */
  maxMotionLength: number;
  /** Increase current-frame weight for subpixel camera motion. */
  useSubpixelCorrection: boolean;
  private readonly _source;
  private readonly _history;
  private readonly _clearColor;
  private readonly _state;
  private readonly _uniforms;
  private readonly _resolveMaterial;
  private readonly _copyMaterial;
  private readonly _quad;
  constructor(scene: Scene, camera: PerspectiveCamera | OrthographicCamera);
  /** Current scene depth, before temporal accumulation. Owned by this pass. */
  get depthTexture(): DepthTexture;
  /** Jittered projection used to capture depthTexture. Treat as read-only. */
  get projectionMatrix(): Matrix4;
  /** Resize all internal targets in physical pixels; a size change clears history. */
  setSize(width: number, height: number): void;
  /** Discard history after a camera cut, scene replacement, or color-space change. */
  reset(): void;
  /** Render the scene and resolve TAA into the composer's working-space buffer. */
  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget): void;
  dispose(): void;
}
