import type { WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import type { Uniforms } from "../uniforms";
import { ProjectedSplats } from "./ProjectedSplats";
import type { ProjectionCacheExtension } from "./ProjectionCacheExtension";

/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export class WebGPUSplatBackend extends NodeSplatBackend {
  readonly kind = "webgpu";
  readonly projection: ProjectedSplats;
  precompile: Promise<void> | null;

  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    const projection = new ProjectedSplats(renderer, uniforms);
    super(
      renderer,
      uniforms,
      options,
      undefined,
      (camera, stochastic, shaded) =>
        projection.vertexData(camera, stochastic, shaded),
    );
    this.projection = projection;
    const pending = projection.ready.finally(() => {
      if (this.precompile === pending) this.precompile = null;
    });
    this.precompile = pending;
  }

  /** Installs or removes records supplied by a plugin, then readies the new kernels. */
  setProjectionExtension(extension: ProjectionCacheExtension | null) {
    const pending = this.projection.setExtension(extension).finally(() => {
      if (this.precompile !== pending) return;
      this.precompile = null;
      this.projection.onKernelsReady?.();
    });
    this.precompile = pending;
    return pending;
  }

  get sortError() {
    return this.projection.error;
  }
  getOrderingCapacity(count: number) {
    return Math.max(1, count);
  }

  dispose() {
    super.dispose();
    this.projection.dispose();
  }
}
