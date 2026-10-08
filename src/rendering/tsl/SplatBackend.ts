import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import type { Uniforms } from "../uniforms";
import {
  type ProjectedVertexData,
  type SplatNodeMaterial,
  type SplatShading,
  createSplatNodeMaterial,
} from "./SplatMaterial";

/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  readonly sortedMaterial: SplatNodeMaterial;
  readonly stochasticMaterial: SplatNodeMaterial;
  /** Builds a material of this backend; with `shading`, a shaded variant. */
  readonly createMaterial: <Extra>(
    stochastic: boolean,
    shading?: SplatShading<Extra>,
  ) => SplatNodeMaterial;

  constructor(
    readonly renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TextureNode<"uvec4">,
    vertexData?: (
      camera: THREE.Camera,
      stochastic: boolean,
      shaded: boolean,
    ) => ProjectedVertexData,
  ) {
    this.createMaterial = (stochastic, shading) =>
      createSplatNodeMaterial({
        uniforms,
        ...options,
        orderingNode,
        vertexData,
        stochastic,
        shading,
      });
    this.sortedMaterial = this.createMaterial(false);
    this.stochasticMaterial = this.createMaterial(true);
  }

  selectMaterial(stochastic: boolean) {
    return stochastic ? this.stochasticMaterial : this.sortedMaterial;
  }

  dispose() {
    this.sortedMaterial.dispose();
    this.stochasticMaterial.dispose();
  }
}
