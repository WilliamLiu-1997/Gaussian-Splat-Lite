import type * as THREE from "three";
import type { CPUOrderingUpdate, SplatMaterialOptions } from "../backend.js";
import type { Uniforms } from "../uniforms.js";
/** WebGL materials and ordering-texture uploads. */
export declare class WebGLSplatBackend {
  readonly renderer: THREE.WebGLRenderer;
  private readonly uniforms;
  readonly kind = "webgl";
  readonly sortedMaterial: THREE.ShaderMaterial;
  readonly stochasticMaterial: THREE.ShaderMaterial;
  private readonly ordering;
  constructor(
    renderer: THREE.WebGLRenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  );
  selectMaterial(stochastic: boolean): THREE.ShaderMaterial;
  getOrderingCapacity(count: number): number;
  get cpuOrdering(): Uint32Array | null;
  setCPUOrdering(update: CPUOrderingUpdate): void;
  /** Unsorted draws read no ordering; the next sort allocates it again. */
  releaseOrdering(): void;
  dispose(): void;
}
