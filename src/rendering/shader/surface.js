import { N, quatVec } from "../tsl/shaderUtils.js";

/**
 * The covariance ellipsoid's outward normal at its central visible point:
 * normalize(inverse(covariance) * towardViewer), in view space. Call where
 * the projected Gaussian is in scope.
 */
export function surfaceNormal({
  scales,
  viewQuaternion,
  viewCenter,
  isOrthographic,
}) {
  const towardViewer = N.select(
    isOrthographic,
    N.vec3(0, 0, 1),
    viewCenter.negate().normalize(),
  ).toVar();
  const localView = quatVec(
    N.vec4(viewQuaternion.xyz.negate(), viewQuaternion.w),
    towardViewer,
  ).toVar();
  const shortest = scales.x.min(scales.y).min(scales.z);
  // Zero axes have no covariance inverse; give them a relative finite width.
  const normalScale = N.select(
    shortest.equal(0),
    scales.x.max(scales.y).max(scales.z).mul(1e-6),
    shortest,
  ).toVar();
  // A common scale factor preserves the normal without forming 1 / scale².
  const inverseScale = normalScale.div(scales.max(normalScale)).toVar();
  const localNormal = localView.mul(inverseScale).mul(inverseScale);
  return quatVec(viewQuaternion, localNormal).normalize();
}
