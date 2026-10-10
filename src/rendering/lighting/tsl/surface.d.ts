import type { Node } from "three/webgpu";
import type {
  ProjectedGaussian,
  ProjectionExtension,
} from "../../tsl/ProjectionProgram.js";
import type { SplatSurface } from "../../tsl/SplatMaterial.js";
/**
 * The covariance ellipsoid's outward normal at its central visible point:
 * normalize(inverse(covariance) * towardViewer), in view space. Call where
 * the projected Gaussian is in scope.
 */
export declare function surfaceNormal(
  gaussian: ProjectedGaussian,
): Node<"vec3">;
/**
 * Projection extension: the surface that vertex-stage shading reads. It
 * keeps the Gaussian, so draws whose lights use no normal never derive one.
 */
export declare const surfaceProjection: ProjectionExtension<SplatSurface>;
