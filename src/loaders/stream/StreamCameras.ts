import * as THREE from "three";

/** A renderer whose size, in CSS pixels, sets a camera's resolution. */
export type StreamResolutionSource = {
  getSize(target: THREE.Vector2): THREE.Vector2;
};

const size = new THREE.Vector2();
const identity = new THREE.Matrix4();

/**
 * Bring a registered camera's world matrices up to date and report whether it
 * can select detail. WebXR uses the eye matrices supplied by Three, preserving
 * their rig transforms. Wait until the eyes have a projection and viewport.
 */
function prepareStreamCamera(camera: THREE.Camera) {
  const array = camera as THREE.ArrayCamera;
  if (array.isArrayCamera) {
    return (
      array.cameras.length > 0 &&
      array.cameras.every(
        (eye) =>
          (eye.viewport?.z ?? 0) > 0 &&
          (eye.viewport?.w ?? 0) > 0 &&
          !eye.projectionMatrix.equals(identity) &&
          !(eye.matrixWorld.equals(identity) && !eye.matrix.equals(identity)),
      )
    );
  }
  camera.updateWorldMatrix(true, false);
  return true;
}

/** Capture actual eye poses; the ArrayCamera rig can be unset on its first frame. */
export function streamViews(cameras: readonly THREE.Camera[]) {
  const views: THREE.Camera[] = [];
  for (const camera of cameras) {
    if (!prepareStreamCamera(camera)) continue;
    const array = camera as THREE.ArrayCamera;
    if (array.isArrayCamera) views.push(...array.cameras);
    else views.push(camera);
  }
  return views;
}

/** Cameras that select a streamed model's detail, with their resolutions. */
export class StreamCameras {
  // Keys keep registration order.
  private readonly resolutions = new Map<THREE.Camera, THREE.Vector2>();

  /** Registered cameras, in registration order. */
  get cameras() {
    return [...this.resolutions.keys()];
  }

  has(camera: THREE.Camera) {
    return this.resolutions.has(camera);
  }

  add(camera: THREE.Camera) {
    if (this.resolutions.has(camera)) return false;
    this.resolutions.set(camera, new THREE.Vector2());
    return true;
  }

  delete(camera: THREE.Camera) {
    return this.resolutions.delete(camera);
  }

  setResolution(
    camera: THREE.Camera,
    xOrVec: number | THREE.Vector2,
    y?: number,
  ) {
    const resolution = this.resolutions.get(camera);
    if (!resolution) return false;
    const width = typeof xOrVec === "number" ? xOrVec : xOrVec.x;
    const height = typeof xOrVec === "number" ? (y ?? Number.NaN) : xOrVec.y;
    if (!(width > 0 && height > 0) || !Number.isFinite(width + height))
      throw new Error("Camera resolution must be positive and finite");
    resolution.set(width, height);
    return true;
  }

  setResolutionFromRenderer(
    camera: THREE.Camera,
    renderer: StreamResolutionSource,
  ) {
    return this.setResolution(camera, renderer.getSize(size));
  }

  /** The camera's resolution, or undefined until one is set. */
  getResolution(camera: THREE.Camera) {
    const resolution = this.resolutions.get(camera);
    return resolution && resolution.x > 0 ? resolution : undefined;
  }

  /**
   * Registered cameras that see `layers`. Throws when none are registered,
   * since nothing could select detail.
   */
  seeing(layers: THREE.Layers) {
    if (!this.resolutions.size)
      throw new Error("Register a camera with setCamera() before update()");
    const cameras: THREE.Camera[] = [];
    for (const camera of this.resolutions.keys())
      if (camera.layers.test(layers)) cameras.push(camera);
    return cameras;
  }
}
