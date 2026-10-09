import type { WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend.js";
import { NodeSplatBackend } from "../tsl/SplatBackend.js";
import type { Uniforms } from "../uniforms.js";
import type { ProjectedSplats } from "./ProjectedSplats.js";
/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export declare class WebGPUSplatBackend extends NodeSplatBackend {
  readonly kind = "webgpu";
  readonly projection: ProjectedSplats;
  precompile: Promise<void> | null;
  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  );
  get sortError(): unknown;
  getOrderingCapacity(count: number): number;
  dispose(): void;
}
