import type * as THREE from "three";
import type { GaussianSplatRenderer } from "../rendering/GaussianSplatRenderer.js";
import type { GaussianSplatCompatibleRenderer } from "../rendering/rendererUtils.js";
export type SplatCaptureTargetOptions = {
  width: number;
  height: number;
  doubleBuffer?: boolean;
  superXY?: number;
} & Omit<THREE.RenderTargetOptions, "stencilBuffer">;
export interface SplatCaptureOptions {
  splatRenderer: GaussianSplatRenderer;
  target?: SplatCaptureTargetOptions;
}
export interface SplatCaptureCubeOptions {
  scene: THREE.Scene;
  worldCenter: THREE.Vector3;
  size?: number;
  near?: number;
  far?: number;
  hideObjects?: THREE.Object3D[];
  filter?: boolean;
}
export type SplatCaptureEnvOptions = Omit<SplatCaptureCubeOptions, "filter">;
type SceneView = {
  scene: THREE.Scene;
  camera: THREE.Camera;
};
/** Optional offscreen capture and environment maps, independent of core rendering. */
export declare class SplatCapture {
  readonly splatRenderer: GaussianSplatRenderer;
  readonly superXY: number;
  target?: THREE.RenderTarget;
  backTarget?: THREE.RenderTarget;
  superPixels?: Uint8Array;
  targetPixels?: Uint8Array;
  private disposed;
  private readonly captureRenderer;
  private readonly capturePass;
  private pending;
  private readonly cubeRenders;
  private lastCube;
  private pmrem;
  constructor({ splatRenderer, target }: SplatCaptureOptions);
  private initializeTarget;
  get renderer(): GaussianSplatCompatibleRenderer;
  private get stencilBuffer();
  private assertActive;
  private enqueue;
  private renderCapture;
  /** Snapshots the camera now; the capture may wait for earlier ones. */
  private targetCapture;
  renderTarget(view: SceneView): Promise<THREE.RenderTarget>;
  /** Reuses the returned buffer; copy it if a later read must not overwrite it. */
  readTarget(): Promise<Uint8Array>;
  renderReadTarget(view: SceneView): Promise<Uint8Array>;
  private renderCube;
  /** Validates and snapshots the center now; the capture may wait for earlier ones. */
  private cubeCapture;
  renderCubeMap(options: SplatCaptureCubeOptions): Promise<THREE.CubeTexture>;
  /** Faces of the latest cube capture, in the WebGL layout on every backend. */
  readCubeTargets(): Promise<Uint8Array[]>;
  /** The caller owns the result; texture.dispose() also releases its render target. */
  renderEnvMap(options: SplatCaptureEnvOptions): Promise<THREE.Texture>;
  recurseSetEnvMap(root: THREE.Object3D, envMap: THREE.Texture): void;
  dispose(): void;
}
