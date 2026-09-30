import * as THREE from "three";
import {
  NodeMaterial,
  type TextureNode,
  type WebGPURenderer,
} from "three/webgpu";
import { STOP_TRANSMITTANCE } from "../LayeredOverdraw";
import { N, load2D } from "./shaderUtils";

/** Layers binding for stop masks and composites; set its value per target. */
export function createLayersNode(type: THREE.TextureDataType) {
  const data =
    type === THREE.FloatType ? new Float32Array(4) : new Uint16Array(4);
  const placeholder = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, type);
  placeholder.needsUpdate = true;
  return N.texture(placeholder) as unknown as TextureNode<"vec4">;
}

/** Moves pixels that are already opaque to the nearest depth. */
export function createLayerStopMaterial(
  renderer: WebGPURenderer,
  layers: TextureNode<"vec4">,
) {
  const reversed = renderer.reversedDepthBuffer;
  const nearClip = reversed
    ? 1
    : renderer.coordinateSystem === THREE.WebGPUCoordinateSystem
      ? 0
      : -1;
  const material = new NodeMaterial();
  // A constant clip depth keeps the write rasterized rather than
  // shader-exported, except with logarithmic depth.
  material.vertexNode = N.vec4(N.positionGeometry.xy, nearClip, 1);
  if (renderer.logarithmicDepthBuffer) {
    material.depthNode = N.float(reversed ? 1 : 0);
  }
  material.fragmentNode = N.Fn(() => {
    load2D(layers, N.ivec2(N.screenCoordinate.xy))
      .a.greaterThan(STOP_TRANSMITTANCE)
      .discard();
    return N.vec4(0);
  })();
  material.blending = THREE.NoBlending;
  material.colorWrite = false;
  // WebGL writes depth only while testing it; Three inverts Always under
  // reversed depth.
  material.depthTest = true;
  material.depthFunc = reversed ? THREE.NeverDepth : THREE.AlwaysDepth;
  material.depthWrite = true;
  material.toneMapped = false;
  material.fog = false;
  return material;
}
