import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { SplatModifier } from "../SplatModifier.js";
import type { SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
import type {
  ProjectedVertexData,
  SplatNodeMaterial,
} from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export declare class NodeSplatBackend {
  readonly renderer: WebGPURenderer;
  readonly createMaterial: (
    stochastic: boolean,
    modifier?: SplatModifier | null,
  ) => SplatNodeMaterial;
  sortedMaterial: SplatNodeMaterial;
  stochasticMaterial: SplatNodeMaterial;
  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TextureNode<"uvec4">,
    vertexData?: (
      camera: THREE.Camera,
      stochastic: boolean,
    ) => ProjectedVertexData,
  );
  selectMaterial(stochastic: boolean): SplatNodeMaterial;
  dispose(): void;
}
