import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { MaterialVariants } from "../MaterialVariants.js";
import type { SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
import type {
  ProjectedVertexData,
  SplatNodeMaterial,
  SplatShading,
} from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export declare class NodeSplatBackend {
  readonly renderer: WebGPURenderer;
  private readonly materials: MaterialVariants<SplatNodeMaterial, SplatShading>;
  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    orderingNode?: TextureNode<"uvec4">,
    vertexData?: (
      camera: THREE.Camera,
      stochastic: boolean,
      shaded: boolean,
    ) => ProjectedVertexData,
  );
  /** `shading`, when given, selects the variant that recolors its Splats. */
  selectMaterial(
    stochastic: boolean,
    shading?: SplatShading | null,
  ): SplatNodeMaterial;
  dispose(): void;
}
