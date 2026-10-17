import { NodeSplatBackend } from "../tsl/SplatBackend.js";
import { ProjectedSplats } from "./ProjectedSplats.js";
/** Native WebGPU: fixed compute projection, visible compaction, GPU sort and indirect draw. */
export class WebGPUSplatBackend extends NodeSplatBackend {
  constructor(renderer, uniforms, options) {
    const projection = new ProjectedSplats(renderer, uniforms);
    super(
      renderer,
      uniforms,
      options,
      undefined,
      (camera, stochastic, effect) =>
        projection.vertexData(camera, stochastic, effect),
    );
    this.kind = "webgpu";
    this.projection = projection;
  }
  getOrderingCapacity(count) {
    return Math.max(1, count);
  }
  dispose() {
    super.dispose();
    this.projection.dispose();
  }
}
