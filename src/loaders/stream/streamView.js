import * as THREE from "three";
import { streamViews } from "./StreamCameras.js";
/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose and frustum.
 */
export function captureStreamView(cameras, group) {
  group.updateWorldMatrix(true, false);
  const views = [];
  for (const camera of streamViews(cameras)) {
    views.push({
      // Invert matrixWorld like the splat projection: Camera.matrixWorldInverse
      // can omit rig scale.
      modelView: new THREE.Matrix4()
        .copy(camera.matrixWorld)
        .invert()
        .multiply(group.matrixWorld).elements,
      projection: camera.projectionMatrix.toArray(),
      coordinateSystem: camera.coordinateSystem,
      reversedDepth: camera.reversedDepth,
    });
  }
  let shown = cameras.length > 0;
  for (let node = group; node; node = node.parent) shown &&= node.visible;
  return { cameras: views, shown };
}
/** Stable key of a view, for skipping unchanged selection requests. */
export function getStreamViewKey(view) {
  return view.cameras
    .map(
      (camera) =>
        `${camera.modelView.join(",")}/${camera.projection.join(",")}/${camera.coordinateSystem}/${camera.reversedDepth}`,
    )
    .join(";");
}
/** Worker-side frusta and positions of a captured view, in group coordinates. */
export class StreamFrusta {
  constructor() {
    this.cameras = [];
    this.clip = new THREE.Matrix4();
    this.inverseModelView = new THREE.Matrix4();
    this.closest = new THREE.Vector3();
  }
  prepare(view) {
    const cameras = this.cameras;
    cameras.length = Math.min(cameras.length, view.cameras.length);
    view.cameras.forEach((camera, index) => {
      let state = cameras[index];
      if (!state) {
        state = {
          modelView: new THREE.Matrix4(),
          frustum: new THREE.Frustum(),
          cameraPosition: new THREE.Vector3(),
          fovScale: 1,
        };
        cameras[index] = state;
      }
      state.modelView.fromArray(camera.modelView);
      this.clip.fromArray(camera.projection).multiply(state.modelView);
      this.inverseModelView.copy(state.modelView).invert();
      state.cameraPosition.setFromMatrixPosition(this.inverseModelView);
      state.frustum.setFromProjectionMatrix(
        this.clip,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      const projection = camera.projection;
      state.fovScale =
        projection[11] === 0
          ? 1
          : 1 /
            (Math.max(Math.abs(projection[0]), Math.abs(projection[5])) *
              Math.tan(Math.PI / 8));
    });
    return cameras;
  }
  /** World-space distance from a camera to the box, compensated for its field of view. */
  distance(camera, box) {
    box
      .clampPoint(camera.cameraPosition, this.closest)
      .applyMatrix4(camera.modelView);
    return Math.max(this.closest.length() * camera.fovScale, 1e-6);
  }
}
