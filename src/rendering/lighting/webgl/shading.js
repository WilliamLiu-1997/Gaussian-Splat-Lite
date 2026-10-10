import { LIGHT_TEXTURE_WIDTH } from "../LightData.js";
import shading from "./shading.glsl";
import surface from "./surface.glsl";

/**
 * Lambert shading for WebGLRenderer's material, the GLSL twin of
 * tsl/shading.js: vertex-stage shading at each Splat's center, with its color
 * as albedo.
 */
export function createWebGLLitShading(data) {
  return {
    uniforms: { gslLights: { value: data.texture } },
    vertexPars: [
      `#define GSL_LIGHT_TEXTURE_WIDTH ${LIGHT_TEXTURE_WIDTH}`,
      surface,
      shading,
    ].join("\n"),
    vertex:
      "rgba.rgb = splatShade(rgba.rgb, viewCenter, scales, viewQuaternion);",
  };
}
