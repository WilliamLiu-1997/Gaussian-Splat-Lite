import type { Node } from "three/webgpu";
import type { ProjectionExtension } from "../../../rendering/tsl/ProjectionProgram";
import { N, quatVec } from "../../../rendering/tsl/shaderUtils";
import { poplessDepthShift } from "./poplessDepth";

export type SurfaceOutputs = {
  /** The view normal: the shortest axis, turned to the viewer. */
  normal: Node<"vec3">;
  /** View depth gradient per unit of Splat UV. */
  gradient: Node<"vec2">;
};

/**
 * The surface lit Splats are shaded on, computed with their projection:
 * always, or only while `enabled` is set.
 */
export function surfaceProjection(
  enabled?: Node<"bool">,
): ProjectionExtension<SurfaceOutputs> {
  return {
    declare: () => ({
      normal: N.vec3(0, 0, 1).toVar(),
      gradient: N.vec2(0).toVar(),
    }),
    assign(outputs, gaussian) {
      const assign = () => {
        const { scales, isOrthographic, p0, p1, a, b, d } = gaussian;
        const axis = N.select(
          scales.x
            .lessThanEqual(scales.y)
            .and(scales.x.lessThanEqual(scales.z)),
          N.vec3(1, 0, 0),
          N.select(
            scales.y.lessThanEqual(scales.z),
            N.vec3(0, 1, 0),
            N.vec3(0, 0, 1),
          ),
        );
        const normal = quatVec(gaussian.viewQuaternion, axis).toVar();
        const towardViewer = N.select(
          isOrthographic,
          N.vec3(0, 0, 1),
          gaussian.viewCenter.negate(),
        );
        outputs.normal.assign(
          N.select(
            normal.dot(towardViewer).lessThan(0),
            normal.negate(),
            normal,
          ),
        );
        // Expected view depth across the footprint: the covariance of depth
        // with screen position, through the inverse of the 2D covariance. The
        // perspective Jacobian divides by view Z, which is negative.
        const rowZ = gaussian.rotationScale.transpose().mul(N.vec3(0, 0, 1));
        const crossZ = N.vec2(rowZ.dot(p0), rowZ.dot(p1));
        const gradient = N.vec2(
          d.mul(crossZ.x).sub(b.mul(crossZ.y)),
          a.mul(crossZ.y).sub(b.mul(crossZ.x)),
        )
          .div(a.mul(d).sub(b.mul(b)))
          .mul(N.select(isOrthographic, 1, -1));
        outputs.gradient.assign(
          N.vec2(
            gradient.dot(gaussian.eigenVector1).mul(gaussian.scale1),
            gradient.dot(gaussian.eigenVector2).mul(gaussian.scale2),
          ).div(gaussian.supportRadius.max(1e-20)),
        );
      };
      if (enabled) N.If(enabled, assign);
      else assign();
    },
  };
}

/** The covariance depth plane shadow casters draw; see poplessDepthShift. */
export const depthPlaneProjection: ProjectionExtension<Node<"vec2">> = {
  declare: () => N.vec2(0).toVar(),
  assign(shift, gaussian) {
    shift.assign(
      poplessDepthShift(
        gaussian.rotationScale,
        gaussian.viewCenter,
        gaussian.axis1,
        gaussian.axis2,
        gaussian.projectionMatrix,
      ),
    );
  },
};
