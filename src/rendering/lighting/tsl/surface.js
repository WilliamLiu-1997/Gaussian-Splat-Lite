import { N, quatVec } from "../../tsl/shaderUtils.js";

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

/** The normal as a node, evaluated where shading reads it. */
const deferredNormal = N.Fn(
  ([scales, viewQuaternion, viewCenter, isOrthographic]) =>
    surfaceNormal({ scales, viewQuaternion, viewCenter, isOrthographic }),
);

/**
 * Projection extension: the surface that vertex-stage shading reads. It
 * keeps the Gaussian, so draws whose lights use no normal never derive one.
 */
export const surfaceProjection = {
  declare() {
    const gaussian = {
      scales: N.vec3(1).toVar(),
      viewQuaternion: N.vec4(0, 0, 0, 1).toVar(),
      viewCenter: N.vec3(0).toVar(),
      isOrthographic: N.bool(false).toVar(),
    };
    return {
      gaussian,
      viewCenter: gaussian.viewCenter,
      normal: deferredNormal(
        gaussian.scales,
        gaussian.viewQuaternion,
        gaussian.viewCenter,
        gaussian.isOrthographic,
      ),
    };
  },
  assign(surface, gaussian) {
    for (const name in surface.gaussian)
      surface.gaussian[name].assign(gaussian[name]);
  },
};
