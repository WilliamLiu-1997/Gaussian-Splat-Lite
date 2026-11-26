import { MathUtils, Vector3 } from "three";

export function frameBounds(
  bounds,
  camera,
  controls,
  { elevation, maxDistance },
) {
  const viewElevation = MathUtils.degToRad(elevation);
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() * 0.5, 0.01);

  camera.near = Math.min(radius * 0.001, 0.1);
  camera.far = radius * 200;
  camera.updateProjectionMatrix();
  camera.position
    .set(0, Math.sin(viewElevation), Math.cos(viewElevation))
    .multiplyScalar(Math.min(maxDistance, radius))
    .add(center);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);

  controls.minDistance = Math.min(1, radius * 0.01);
  controls.setCamera(camera);
}
