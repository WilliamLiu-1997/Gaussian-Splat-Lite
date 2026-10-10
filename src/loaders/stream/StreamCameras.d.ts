import type * as THREE from "three";
/** A renderer whose size, in CSS pixels, sets a camera's resolution. */
export type StreamResolutionSource = {
  getSize(target: THREE.Vector2): THREE.Vector2;
};
/** Capture actual eye poses; the ArrayCamera rig can be unset on its first frame. */
export declare function streamViews(
  cameras: readonly THREE.Camera[],
): THREE.Camera[];
/** Cameras that select a streamed model's detail, with their resolutions. */
export declare class StreamCameras {
  private readonly resolutions;
  /** Registered cameras, in registration order. */
  get cameras(): THREE.Camera[];
  has(camera: THREE.Camera): boolean;
  add(camera: THREE.Camera): boolean;
  delete(camera: THREE.Camera): boolean;
  setResolution(
    camera: THREE.Camera,
    xOrVec: number | THREE.Vector2,
    y?: number,
  ): boolean;
  setResolutionFromRenderer(
    camera: THREE.Camera,
    renderer: StreamResolutionSource,
  ): boolean;
  /** The camera's resolution, or undefined until one is set. */
  getResolution(camera: THREE.Camera): THREE.Vector2 | undefined;
  /**
   * Registered cameras that see `layers`. Throws when none are registered,
   * since nothing could select detail.
   */
  seeing(layers: THREE.Layers): THREE.Camera[];
}
