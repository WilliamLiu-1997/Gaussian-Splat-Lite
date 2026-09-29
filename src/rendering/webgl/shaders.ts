import * as THREE from "three";

import splatDefines from "./shaders/splatDefines.glsl";
import splatFragment from "./shaders/splatFragment.glsl";
import splatLighting from "./shaders/splatLighting.glsl";
import splatSource from "./shaders/splatSource.glsl";
import splatVertex from "./shaders/splatVertex.glsl";

let shaders: Record<string, string> | null = null;

export function getShaders(): Record<string, string> {
  if (!shaders) {
    // @ts-ignore
    THREE.ShaderChunk.splatDefines = splatDefines;
    Object.assign(THREE.ShaderChunk, {
      splatLighting,
      splatSource,
      // Coordinates are evaluated per fragment, so light count does not grow
      // the vertex interface. Sampling/filtering stays owned by Three.js.
      gslShadowSampling: THREE.ShaderChunk.shadowmap_pars_fragment
        .replace(
          /varying vec4 vSpotLightCoord\[ NUM_SPOT_LIGHT_COORDS \];/,
          "uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];",
        )
        .replace(
          /varying vec4 vDirectionalShadowCoord\[ NUM_DIR_LIGHT_SHADOWS \];/,
          "uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];",
        )
        .replace(
          /varying vec4 vPointShadowCoord\[ NUM_POINT_LIGHT_SHADOWS \];/,
          "uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];",
        ),
    });
    shaders = {
      splatVertex,
      splatFragment,
    };
  }
  return shaders;
}
