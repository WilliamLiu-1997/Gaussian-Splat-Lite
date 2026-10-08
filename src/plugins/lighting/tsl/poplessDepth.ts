import type { Node } from "three/webgpu";
import { N } from "../../../rendering/tsl/shaderUtils";

/**
 * Covariance-plane depth, adapted from SuperSplat's Popless projection: the
 * plane through a Gaussian's center on which each view ray meets its densest
 * point. Returns the depth shift of the quad's +X and +Y corners; see
 * poplessClipPosition.
 */
export function poplessDepthShift(
  rotationScale: Node<"mat3">,
  center: Node<"vec3">,
  axis1: Node<"vec2">,
  axis2: Node<"vec2">,
  projection: Node<"mat4">,
) {
  const covariance = rotationScale.mul(rotationScale.transpose());
  const c0 = covariance.mul(N.vec3(1, 0, 0)).toVar();
  const c1 = covariance.mul(N.vec3(0, 1, 0)).toVar();
  const c2 = covariance.mul(N.vec3(0, 0, 1)).toVar();
  const ortho = projection.element(2).w.equal(0);
  const toward = N.select(ortho, N.vec3(0, 0, -1), center);
  // adj(Sigma) avoids division by a near-singular covariance determinant.
  const normal = c1
    .cross(c2)
    .mul(toward.x)
    .add(c2.cross(c0).mul(toward.y))
    .add(c0.cross(c1).mul(toward.z))
    .toVar();
  const denominator = N.select(ortho, normal.z, normal.dot(center));
  const gradient = N.vec2(0).toVar();
  N.If(denominator.abs().greaterThan(1e-20), () => {
    gradient.assign(normal.xy.div(denominator));
  });
  const depth = center.z.negate();
  const viewScale = N.select(ortho, N.float(1), depth).div(
    N.vec2(projection.element(0).x, projection.element(1).y),
  );
  return N.vec2(
    gradient.dot(axis1.mul(viewScale)),
    gradient.dot(axis2.mul(viewScale)),
  );
}

/**
 * Keep W fixed: plane depth is affine in screen space, even for perspective.
 * This lets hardware clip the plane at near/far without flattening large Splats
 * or flipping corners behind the eye. Gaussian UVs remain screen-linear.
 */
export function poplessClipPosition(clip: Node<"vec4">, shift: Node<"float">) {
  const projection = N.cameraProjectionMatrix;
  const depthScale = N.select(
    projection.element(2).w.equal(0),
    projection.element(2).z.negate(),
    projection.element(3).z,
  );
  return N.vec4(clip.xy, clip.z.add(depthScale.mul(shift)), clip.w);
}
