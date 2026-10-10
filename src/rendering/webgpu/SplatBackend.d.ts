import type { WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend.js";
import { NodeSplatBackend } from "../tsl/SplatBackend.js";
import type { SplatNodeMaterial, SplatShading } from "../tsl/SplatMaterial.js";
import type { Uniforms } from "../uniforms.js";
import type { ProjectedSplats, ProjectedSurfaces } from "./ProjectedSplats.js";
import type { ProjectionCache } from "./ProjectionCache.js";
/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export declare class WebGPUSplatBackend extends NodeSplatBackend {
  readonly kind = "webgpu";
  readonly projection: ProjectedSplats;
  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
    createSurfaces: (cache: ProjectionCache) => ProjectedSurfaces,
  );
  /** Shaded materials read the surfaces that only shaded kernels cache. */
  selectMaterial(
    stochastic: boolean,
    shading?: SplatShading | null,
  ): SplatNodeMaterial;
  getOrderingCapacity(count: number): number;
  dispose(): void;
}
