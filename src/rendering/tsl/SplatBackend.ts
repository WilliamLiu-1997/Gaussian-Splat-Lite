import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import { usesNativeWebGPU } from "../rendererUtils";
import type { Uniforms } from "../uniforms";
import {
  type ProjectedVertexData,
  type SplatNodeMaterial,
  type VertexDataOptions,
  createSplatNodeMaterial,
} from "./SplatMaterial";
import { SplatVelocity } from "./SplatVelocity";

/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  readonly sortedMaterial: SplatNodeMaterial;
  readonly stochasticMaterial: SplatNodeMaterial;
  readonly velocity: SplatVelocity;

  constructor(
    readonly renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TextureNode<"uvec4">,
    vertexData?: (
      camera: THREE.Camera,
      options: VertexDataOptions,
    ) => ProjectedVertexData,
  ) {
    this.velocity = new SplatVelocity(usesNativeWebGPU(renderer));
    const create = (stochastic: boolean) =>
      createSplatNodeMaterial({
        velocity: this.velocity,
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
    this.velocity.dispose();
    this.sortedMaterial.dispose();
    this.stochasticMaterial.dispose();
  }
}
