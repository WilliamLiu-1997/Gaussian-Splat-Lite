import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend.js";
import type { EffectBinding } from "../shader/EffectBinding.js";
import type { Uniforms } from "../uniforms.js";
import type {
  ProjectedVertexData,
  SplatNodeMaterial,
} from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export declare class NodeSplatBackend {
  readonly renderer: WebGPURenderer;
  readonly sortedMaterial: SplatNodeMaterial;
  readonly stochasticMaterial: SplatNodeMaterial;
  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TextureNode<"uvec4">,
    vertexData?: (
      camera: THREE.Camera,
      stochastic: boolean,
      effect?: EffectBinding | null,
    ) => ProjectedVertexData,
  );
  setEffect(effect: EffectBinding | null): void;
  selectMaterial(stochastic: boolean): SplatNodeMaterial;
  dispose(): void;
}
