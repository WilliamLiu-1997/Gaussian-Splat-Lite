import type { WebGPURenderer } from "three/webgpu";
import type { CPUOrderingUpdate, SplatMaterialOptions } from "../backend.js";
import { NodeSplatBackend } from "../tsl/SplatBackend.js";
import type { Uniforms } from "../uniforms.js";
/** TSL drawing with CPU-sorted indices stored in an integer texture. */
export declare class WebGLFallbackSplatBackend extends NodeSplatBackend {
  readonly kind = "webgl-fallback";
  private readonly ordering;
  private readonly orderingNode;
  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  );
  getOrderingCapacity(count: number): number;
  get cpuOrdering(): Uint32Array | null;
  setCPUOrdering(update: CPUOrderingUpdate): void;
  /** Unsorted draws read no ordering; the next sort allocates it again. */
  releaseOrdering(): void;
  dispose(): void;
}
