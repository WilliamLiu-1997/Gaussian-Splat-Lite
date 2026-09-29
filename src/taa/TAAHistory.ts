import * as THREE from "three";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "../rendering/rendererUtils";

export const TAA_SAMPLES = 256;
export const TAA_MOVING_SAMPLES = 16;

/** Two 12-byte histories: RGBA unorm16 packed in RG32UI, mean depth/count in R32UI. */
export function createTAAHistory(
  renderer: GaussianSplatCompatibleRenderer,
  camera: THREE.Camera,
  size: THREE.Vector2,
) {
  const makeTarget = () => {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGIntegerFormat,
      type: THREE.UnsignedIntType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    const info = target.texture.clone();
    info.format = THREE.RedIntegerFormat;
    info.name = "TAA.meanDepthCount";
    target.textures.push(info);
    target.texture.name = "TAA.color";
    return target;
  };
  const targets = [makeTarget(), makeTarget()];
  const previousWorld = new THREE.Matrix4();
  const previousProjection = new THREE.Matrix4();
  const previousView = new THREE.Matrix4();
  const previousVP = new THREE.Matrix4();
  const viewToPreviousClip = new THREE.Matrix4();
  const viewToPreviousView = new THREE.Matrix4();
  // x: history sample cap, y: valid history (0/1), z: camera moved (0/1),
  // w: rest-frame count, restarted by camera motion or Splat content changes.
  const params = new THREE.Vector4();
  // x: logarithmic encoding scale (0 disables it), y: offset, z: log range.
  const depthParams = new THREE.Vector3();
  const webGPU = isWebGPURenderer(renderer);
  const reversed = webGPU
    ? renderer.reversedDepthBuffer
    : renderer.capabilities.reversedDepthBuffer;
  const zeroToOne =
    reversed ||
    (webGPU && renderer.coordinateSystem === THREE.WebGPUCoordinateSystem);
  let valid = false;
  let index = 0;
  let restFrames = 0;
  let previousVersion = -1;
  return {
    targets,
    params,
    depthParams,
    viewToPreviousClip,
    viewToPreviousView,
    reversed,
    zeroToOne,
    get input() {
      return targets[1 - index];
    },
    get output() {
      return targets[index];
    },
    get needsRender() {
      return restFrames < TAA_SAMPLES;
    },
    reset() {
      valid = false;
      restFrames = 0;
    },
    begin(version: number) {
      if (targets[0].width !== size.x || targets[0].height !== size.y) {
        valid = false;
        for (const target of targets) target.setSize(size.x, size.y);
      }
      if (!valid) {
        // Allocate both before binding the previous history, including its second attachment.
        for (const target of targets) renderer.initRenderTarget(target);
      }
      const moved =
        valid &&
        (!previousWorld.equals(camera.matrixWorld) ||
          !previousProjection.equals(camera.projectionMatrix));
      const changed = valid && version !== previousVersion;
      previousVersion = version;
      restFrames = changed ? 0 : moved || !valid ? 1 : restFrames + 1;
      params.set(
        moved || changed ? TAA_MOVING_SAMPLES : TAA_SAMPLES,
        valid ? 1 : 0,
        moved ? 1 : 0,
        restFrames,
      );
      viewToPreviousClip.multiplyMatrices(previousVP, camera.matrixWorld);
      viewToPreviousView.multiplyMatrices(previousView, camera.matrixWorld);
      this.updateDepthParams();
    },
    updateDepthParams() {
      const perspective = camera as THREE.PerspectiveCamera;
      const logarithmic =
        (webGPU
          ? renderer.logarithmicDepthBuffer
          : renderer.capabilities.logarithmicDepthBuffer) &&
        perspective.isPerspectiveCamera;
      const near = Math.max(perspective.near, 1e-6);
      depthParams.set(
        logarithmic ? (webGPU ? near : 1) : 0,
        logarithmic && !webGPU ? 1 : 0,
        logarithmic
          ? Math.log2(webGPU ? perspective.far / near : perspective.far + 1)
          : 0,
      );
    },
    commit() {
      previousWorld.copy(camera.matrixWorld);
      previousProjection.copy(camera.projectionMatrix);
      previousView.copy(camera.matrixWorld).invert();
      previousVP.multiplyMatrices(camera.projectionMatrix, previousView);
      valid = true;
      index = 1 - index;
    },
    dispose() {
      for (const target of targets) target.dispose();
    },
  };
}
