import type * as THREE from "three";
type WebGPURenderer = import("three/webgpu").WebGPURenderer;
export type GaussianSplatCompatibleRenderer =
  | THREE.WebGLRenderer
  | WebGPURenderer;
export declare function isWebGPURenderer(
  renderer: GaussianSplatCompatibleRenderer,
): renderer is WebGPURenderer;
export declare function usesNativeWebGPU(
  renderer: GaussianSplatCompatibleRenderer,
): boolean;
/**
 * The eyes of a WebXR camera, or the camera itself. An ArrayCamera without
 * eyes draws as a single view.
 */
export declare function getViews(camera: THREE.Camera): THREE.Camera[];
/**
 * Stores the views' mean position and forward direction: the camera's pose,
 * or for WebXR eyes the shared head. Reads world matrices as Three composed
 * them with any camera rig.
 */
export declare function getMeanViewPose(
  views: readonly THREE.Camera[],
  position: THREE.Vector3,
  direction: THREE.Vector3,
): void;
export declare function getRenderFrame(
  renderer: GaussianSplatCompatibleRenderer,
): number;
export declare function isXRRenderTarget(
  renderTarget: THREE.RenderTarget | null,
): boolean;
export declare function assertSupportedRenderer(
  renderer: GaussianSplatCompatibleRenderer,
): void;
export {};
