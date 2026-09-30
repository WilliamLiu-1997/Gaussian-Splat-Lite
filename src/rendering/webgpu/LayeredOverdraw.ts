import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  type LayeredBackend,
  LayeredOverdraw,
  useUnderBlending,
} from "../LayeredOverdraw";
import { SplatGeometry } from "../SplatGeometry";
import type { SplatMaterialOptions } from "../backend";
import {
  createLayerStopMaterial,
  createLayersNode,
} from "../tsl/LayeredMaterials";
import {
  type OrderingNode,
  createSplatNodeMaterial,
} from "../tsl/SplatMaterial";
import { uniformBinding } from "../tsl/shaderUtils";
import type { Uniforms } from "../uniforms";
import type { ProjectedSplats } from "./ProjectedSplats";
import { currentWebGPUPass } from "./RenderPassSplit";

const INDIRECT_STRIDE = 5 * 4;

/** Native WebGPU batches: GPU ranges over the projected sort, drawn indirectly. */
export function createWebGPULayers(
  renderer: WebGPURenderer,
  projection: ProjectedSplats,
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  orderingNode: OrderingNode,
) {
  // Front-to-back sums add ever smaller terms to a growing total, which half
  // floats round away. Float32 blending keeps the tail when available.
  const colorType = renderer.hasFeature("float32-blendable")
    ? THREE.FloatType
    : THREE.HalfFloatType;
  const layers = createLayersNode(colorType);
  const batchState: Uniforms = { batch: { value: 0 } };
  const batch = uniformBinding(batchState, "batch", "uint");
  const batchMaterial = createSplatNodeMaterial({
    uniforms,
    vertexData: (camera) => projection.vertexData(camera, false, batch),
    premultipliedAlpha: true,
    transparent: false,
    depthTest: true,
    depthWrite: false,
    sorted: true,
  });
  useUnderBlending(batchMaterial);
  const geometry = new SplatGeometry();
  geometry.setIndirect(projection.batchIndirect);
  const batchMesh = new THREE.Mesh(geometry, batchMaterial);
  batchMesh.frustumCulled = false;
  batchMesh.matrixAutoUpdate = false;
  // Projection already applied camera and mesh layers.
  batchMesh.layers.enableAll();
  const stopMaterial = createLayerStopMaterial(renderer, layers);

  const backend: LayeredBackend = {
    colorType,
    batchMesh,
    stopMaterial,
    currentPass: () => currentWebGPUPass(renderer),
    planBatches(camera, count) {
      const array = camera as THREE.ArrayCamera;
      const eyes = array.isArrayCamera === true ? array.cameras.length : 1;
      if (eyes === 0) return null;
      projection.prepareBatches(count, eyes);
      return Array.from({ length: count }, (_, index) => index);
    },
    prepareBatch(index) {
      batchState.batch.value = index;
      geometry.indirectOffset = index * INDIRECT_STRIDE;
    },
    bindLayers(texture) {
      layers.value = texture;
    },
  };
  const overdraw = new LayeredOverdraw(renderer, backend);
  // The uniform graph also serves sorted, stochastic and fallback frames.
  const material = createSplatNodeMaterial({
    uniforms,
    ...options,
    orderingNode,
    vertexData: (camera) => projection.vertexData(camera),
    composite: {
      active: uniformBinding(uniforms, "layeredComposite", "bool"),
      layers,
    },
  });
  return {
    overdraw,
    material,
    dispose() {
      overdraw.dispose();
      material.dispose();
      batchMaterial.dispose();
      stopMaterial.dispose();
      geometry.dispose();
    },
  };
}
