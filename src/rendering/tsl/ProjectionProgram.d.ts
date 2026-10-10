import type { Node } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
export type ProjectionView = {
  projectionMatrix: Node<"mat4">;
  renderToViewQuat: Node<"vec4">;
  renderToViewPos: Node<"vec3">;
  renderToViewScale: Node<"float">;
  near: Node<"float">;
  far: Node<"float">;
  renderSize: Node<"vec2">;
};
type ProjectionInput =
  | {
      first: Node<"uvec4">;
      second: Node<"uvec4">;
    }
  | {
      valid: Node<"bool">;
      center: Node<"vec3">;
      lnScales: Node<"vec3">;
      quaternion: Node<"vec4">;
      rgba: Node<"vec4">;
      shapeAmount: Node<"float">;
    };
export type SplatProjection<Extra = undefined> = {
  valid: Node<"bool">;
  clipCenter: Node<"vec4">;
  viewDepth: Node<"float">;
  /** NDC offsets for each +/-1 quad corner. */
  axis1: Node<"vec2">;
  axis2: Node<"vec2">;
  /** Source color space; the draw stage applies encodeLinear. */
  rgba: Node<"vec4">;
  supportRadius: Node<"float">;
  /** A wide kernel's low 16 bits hold its edge fade as a half. */
  supportRadiusSquared: Node<"float">;
  kernelPower: Node<"float">;
  /** Outputs of the projection's extension. */
  extra: Extra;
};
/** A visible Gaussian in view space, as an extension sees it. */
export type ProjectedGaussian = {
  isOrthographic: Node<"bool">;
  viewCenter: Node<"vec3">;
  scales: Node<"vec3">;
  viewQuaternion: Node<"vec4">;
};
/**
 * Derives further outputs from each visible Gaussian: `declare` creates their
 * variables beside the projection's own, and `assign` runs where the Gaussian
 * is in scope.
 */
export type ProjectionExtension<Extra> = {
  declare(): Extra;
  assign(outputs: Extra, gaussian: ProjectedGaussian): void;
};
/**
 * Shared projection for vertex and compute paths. Call inside a TSL Fn.
 * `extension` may derive further outputs from each visible Gaussian.
 */
export declare function createProjectionProgram<Extra = undefined>(
  uniforms: Uniforms,
  view: ProjectionView,
  extension?: ProjectionExtension<Extra>,
): (source: ProjectionInput, includeColor?: boolean) => SplatProjection<Extra>;
export {};
