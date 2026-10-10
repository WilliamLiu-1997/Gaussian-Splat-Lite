import type * as THREE from "three";
import type { MaterialVariants } from "../MaterialVariants.js";
import type { CPUOrderingUpdate, SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
import type { SplatShading } from "./SplatMaterial.js";
/** WebGL materials and ordering-texture uploads. */
export declare class WebGLSplatBackend {
  readonly renderer: THREE.WebGLRenderer;
  private readonly uniforms;
  readonly kind = "webgl";
  private readonly materials: MaterialVariants<
    THREE.ShaderMaterial,
    SplatShading
  >;
  private readonly ordering;
  constructor(
    renderer: THREE.WebGLRenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  );
  /** `shading`, when given, selects the variant that recolors its Splats. */
  selectMaterial(
    stochastic: boolean,
    shading?: SplatShading | null,
  ): THREE.ShaderMaterial;
  getOrderingCapacity(count: number): number;
  get cpuOrdering(): Uint32Array | null;
  setCPUOrdering(update: CPUOrderingUpdate): void;
  /** Unsorted draws read no ordering; the next sort allocates it again. */
  releaseOrdering(): void;
  dispose(): void;
}
