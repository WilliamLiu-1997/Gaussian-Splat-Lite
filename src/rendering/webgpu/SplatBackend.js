import { NodeSplatBackend } from "../tsl/SplatBackend.js";
import { ProjectedSplats } from "./ProjectedSplats.js";
/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export class WebGPUSplatBackend extends NodeSplatBackend {
  constructor(renderer, uniforms, options, createSurfaces) {
    const projection = new ProjectedSplats(renderer, uniforms, createSurfaces);
    super(renderer, uniforms, options, undefined, (...args) =>
      projection.vertexData(...args),
    );
    this.kind = "webgpu";
    this.projection = projection;
  }
  /** Shaded materials read the surfaces that only shaded kernels cache. */
  selectMaterial(stochastic, shading) {
    this.projection.setShaded(Boolean(shading));
    return super.selectMaterial(stochastic, shading);
  }
  getOrderingCapacity(count) {
    return Math.max(1, count);
  }
  dispose() {
    super.dispose();
    this.projection.dispose();
  }
}
