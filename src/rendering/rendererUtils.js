import * as THREE from "three";
export function isWebGPURenderer(renderer) {
  return "isWebGPURenderer" in renderer && renderer.isWebGPURenderer === true;
}
export function usesNativeWebGPU(renderer) {
  return (
    isWebGPURenderer(renderer) &&
    renderer.coordinateSystem === THREE.WebGPUCoordinateSystem
  );
}
/**
 * The eyes of a WebXR camera, or the camera itself. An ArrayCamera without
 * eyes draws as a single view.
 */
export function getViews(camera) {
  return camera.isArrayCamera && camera.cameras.length > 0
    ? camera.cameras
    : [camera];
}
const viewVectorTmp = new THREE.Vector3();
/**
 * Stores the views' mean position and forward direction: the camera's pose,
 * or for WebXR eyes the shared head. Reads world matrices as Three composed
 * them with any camera rig.
 */
export function getMeanViewPose(views, position, direction) {
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
export function getRenderFrame(renderer) {
  return isWebGPURenderer(renderer)
    ? renderer.info.render.calls
    : renderer.info.render.frame;
}
export function isXRRenderTarget(renderTarget) {
  return renderTarget?.isXRRenderTarget === true;
}
export function assertSupportedRenderer(renderer) {
  if (!isWebGPURenderer(renderer)) return;
  if (renderer.initialized !== true) {
    throw new Error(
      "Initialize WebGPURenderer with await renderer.init() before using Gaussian Splat Lite",
    );
  }
  const backend = renderer.backend;
  if (backend.isWebGPUBackend !== true && backend.isWebGLBackend !== true) {
    throw new Error("Gaussian Splat Lite requires a WebGPU or WebGL backend");
  }
}
