import type { SplatShading } from "../../webgl/SplatMaterial.js";
import type { LightData } from "../LightData.js";
/**
 * Lambert shading for WebGLRenderer's material, the GLSL twin of
 * tsl/shading.js: vertex-stage shading at each Splat's center, with its color
 * as albedo.
 */
export declare function createWebGLLitShading(data: LightData): SplatShading;
