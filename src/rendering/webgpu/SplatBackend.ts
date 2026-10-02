import type { WebGPURenderer } from "three/webgpu";
import type { SplatMaterialOptions } from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import type { Uniforms } from "../uniforms";
import { ProjectedSplats } from "./ProjectedSplats";

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
    super(renderer, uniforms, options, undefined, (camera, stochastic) =>
      projection.vertexData(camera, stochastic),
    );
    this.projection = projection;
    this.precompile = projection.ready.finally(() => {
      this.precompile = null;
    });
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
