import type * as THREE from "three";
/** Blend in output space like the canvas, then convert to texture storage. */
export declare class WebGLCapture {
  private readonly renderer;
  private readonly depthTexture;
  private readonly target;
  private readonly camera;
  private readonly material;
  private readonly quad;
  constructor(renderer: THREE.WebGLRenderer);
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}
