import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import type { Uniforms } from "../uniforms";
import {
  type ProjectedVertexData,
  type SplatNodeMaterial,
  createSplatNodeMaterial,
} from "./SplatMaterial";

/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  readonly sortedMaterial: SplatNodeMaterial;
  readonly stochasticMaterial: SplatNodeMaterial;

  constructor(
    readonly renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TextureNode<"uvec4">,
    vertexData?: (
      camera: THREE.Camera,
      stochastic: boolean,
    ) => ProjectedVertexData,
  ) {
    const create = (stochastic: boolean) =>
      createSplatNodeMaterial({
        uniforms,
        ...options,
        orderingNode,
        vertexData,
        stochastic,
      });
    this.sortedMaterial = create(false);
    this.stochasticMaterial = create(true);
  }

  selectMaterial(stochastic: boolean) {
    return stochastic ? this.stochasticMaterial : this.sortedMaterial;
  }

  dispose() {
    this.sortedMaterial.dispose();
    this.stochasticMaterial.dispose();
  }
}
