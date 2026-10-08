import * as THREE from "three";

import splatCovariance from "./shaders/splatCovariance.glsl";
import splatDefines from "./shaders/splatDefines.glsl";
import splatFootprint from "./shaders/splatFootprint.glsl";
import splatFragment from "./shaders/splatFragment.glsl";
import splatSource from "./shaders/splatSource.glsl";
import splatVertex from "./shaders/splatVertex.glsl";

let shaders: Record<string, string> | null = null;

export function getShaders(): Record<string, string> {
  if (!shaders) {
    Object.assign(THREE.ShaderChunk, {
      splatCovariance,
      splatDefines,
      splatFootprint,
      splatSource,
      // Optional material variants insert declarations and code here.
      splatShadingPars: "",
      splatShading: "",
    });
    shaders = {
      splatVertex,
      splatFragment,
    };
  }
  return shaders;
}
