import type * as THREE from "three";
export type StreamViewCamera = {
  modelView: number[];
  projection: number[];
  coordinateSystem: THREE.CoordinateSystem;
  reversedDepth: boolean;
};
export type StreamView = {
  /** The registered cameras that see the group; selection serves all of them. */
  cameras: StreamViewCamera[];
  shown: boolean;
};
/** Prepared worker-side state of one captured camera. */
export type StreamFrustum = {
  modelView: THREE.Matrix4;
  frustum: THREE.Frustum;
  cameraPosition: THREE.Vector3;
  fovScale: number;
};
/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose and frustum.
 */
export declare function captureStreamView(
  cameras: readonly THREE.Camera[],
  group: THREE.Object3D,
): StreamView;
/** Stable key of a view, for skipping unchanged selection requests. */
export declare function getStreamViewKey(view: StreamView): string;
/** Worker-side frusta and positions of a captured view, in group coordinates. */
export declare class StreamFrusta {
  private readonly cameras;
  private readonly clip;
  private readonly inverseModelView;
  private readonly closest;
  prepare(view: StreamView): StreamFrustum[];
  /** World-space distance from a camera to the box, compensated for its field of view. */
  distance(camera: StreamFrustum, box: THREE.Box3): number;
}
