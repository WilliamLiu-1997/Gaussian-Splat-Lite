import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
/** Blend in working space, then convert to texture storage. */
export declare class WebGPUCapture {
  private readonly renderer;
  private readonly depthTexture;
  private readonly target;
  private readonly material;
  private readonly quad;
  private workingColorSpace;
  private outputColorSpace;
  private storageColorSpace;
  private toneMapping;
  constructor(renderer: WebGPURenderer);
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}
