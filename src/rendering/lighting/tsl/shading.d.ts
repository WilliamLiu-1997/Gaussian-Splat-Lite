import type { SplatShading } from "../../tsl/SplatMaterial.js";
import type { Uniforms } from "../../uniforms.js";
import type { LightData } from "../LightData.js";
/**
 * Vertex-stage Lambert shading at each Splat's center, using its color as
 * albedo.
 */
export declare function createNodeLitShading(
  data: LightData,
  uniforms: Uniforms,
): SplatShading;
