import * as THREE from "three";
import type {
  PatchedBackend,
  PatchedRenderTarget,
  PatchedWebGPUBackend,
} from "../patches/threeTypes";

type WebGPURenderer = import("three/webgpu").WebGPURenderer;

export type GaussianSplatCompatibleRenderer =
  | THREE.WebGLRenderer
  | WebGPURenderer;

export function isWebGPURenderer(
  renderer: GaussianSplatCompatibleRenderer,
): renderer is WebGPURenderer {
  return "isWebGPURenderer" in renderer && renderer.isWebGPURenderer === true;
}

export function usesNativeWebGPU(
  renderer: GaussianSplatCompatibleRenderer,
): boolean {
  return (
    isWebGPURenderer(renderer) &&
    renderer.coordinateSystem === THREE.WebGPUCoordinateSystem
  );
}

/** Backend declarations omit the flags and texture upload used here. */
export function getRendererBackend(renderer: WebGPURenderer): PatchedBackend {
  return renderer.backend as PatchedBackend;
}

/** Only call for a renderer using the native WebGPU backend. */
export function getWebGPUDeviceLimits(renderer: WebGPURenderer) {
  return (renderer.backend as PatchedWebGPUBackend).device.limits;
}

/**
 * The eyes of a WebXR camera, or the camera itself. An ArrayCamera without
 * eyes draws as a single view.
 */
export function getViews(camera: THREE.Camera): THREE.Camera[] {
  const array = camera as THREE.ArrayCamera;
  return array.isArrayCamera && array.cameras.length > 0
    ? array.cameras
    : [camera];
}

const viewVectorTmp = new THREE.Vector3();

/**
 * Stores the views' mean position and forward direction: the camera's pose,
 * or for WebXR eyes the shared head. Reads world matrices as Three composed
 * them with any camera rig.
 */
export function getMeanViewPose(
  views: readonly THREE.Camera[],
  position: THREE.Vector3,
  direction: THREE.Vector3,
) {
  position.set(0, 0, 0);
  direction.set(0, 0, 0);
  for (const view of views) {
    position.add(viewVectorTmp.setFromMatrixPosition(view.matrixWorld));
    direction.add(
      viewVectorTmp.setFromMatrixColumn(view.matrixWorld, 2).normalize(),
    );
  }
  position.divideScalar(views.length);
  direction.normalize().negate();
}

export function getRenderFrame(renderer: GaussianSplatCompatibleRenderer) {
  return isWebGPURenderer(renderer)
    ? renderer.info.render.calls
    : renderer.info.render.frame;
}

export function isXRRenderTarget(
  renderTarget: THREE.RenderTarget | null,
): boolean {
  return (
    (renderTarget as PatchedRenderTarget | null)?.isXRRenderTarget === true
  );
}

export function assertSupportedRenderer(
  renderer: GaussianSplatCompatibleRenderer,
) {
  if (!isWebGPURenderer(renderer)) return;
  if (renderer.initialized !== true) {
    throw new Error(
      "Initialize WebGPURenderer with await renderer.init() before using Gaussian Splat Lite",
    );
  }
  const backend = getRendererBackend(renderer);
  if (backend.isWebGPUBackend !== true && backend.isWebGLBackend !== true) {
    throw new Error("Gaussian Splat Lite requires a WebGPU or WebGL backend");
  }
}

export function setRendererRenderTarget(
  renderer: GaussianSplatCompatibleRenderer,
  target: THREE.RenderTarget | null,
  activeCubeFace?: number,
  activeMipmapLevel?: number,
) {
  renderer.setRenderTarget(
    target as THREE.WebGLRenderTarget | null,
    activeCubeFace,
    activeMipmapLevel,
  );
}
