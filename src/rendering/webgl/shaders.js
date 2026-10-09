import * as THREE from "three";
import splatDefines from "./shaders/splatDefines.glsl";
import splatFragment from "./shaders/splatFragment.glsl";
import splatVertex from "./shaders/splatVertex.glsl";
let shaders = null;
export function getShaders() {
  if (!shaders) {
    Object.assign(THREE.ShaderChunk, { splatDefines });
    shaders = {
      splatVertex,
      splatFragment,
    };
  }
  return shaders;
}
