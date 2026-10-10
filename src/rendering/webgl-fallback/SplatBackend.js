import { NodeSplatBackend } from "../tsl/SplatBackend.js";
import { uintTexture } from "../tsl/shaderUtils.js";
import { emptyOrdering } from "../uniforms.js";
import { OrderingTexture } from "../webgl/OrderingTexture.js";
/** TSL drawing with CPU-sorted indices stored in an integer texture. */
export class WebGLFallbackSplatBackend extends NodeSplatBackend {
  constructor(renderer, uniforms, options) {
    // Shared by the sorted and stochastic materials.
    const orderingNode = uintTexture(emptyOrdering);
    super(renderer, uniforms, options, orderingNode);
    this.kind = "webgl-fallback";
    this.ordering = new OrderingTexture();
    this.orderingNode = orderingNode;
  }
  getOrderingCapacity(count) {
    return this.ordering.getCapacity(count);
  }
  get cpuOrdering() {
    return this.ordering.data;
  }
  setCPUOrdering(update) {
    this.orderingNode.value = this.ordering.update(update, (texture, rows) => {
      // Finish any pending allocation before uploading only active rows.
      this.renderer.initTexture(texture);
      // Update the destination directly to avoid copyTextureToTexture's
      // GPU staging texture.
      this.renderer.backend.updateTexture(texture, {
        width: texture.image.width,
        height: rows,
        image: texture.image,
      });
    });
  }
  /** Unsorted draws read no ordering; the next sort allocates it again. */
  releaseOrdering() {
    this.ordering.dispose();
    this.orderingNode.value = emptyOrdering;
  }
  dispose() {
    super.dispose();
    this.ordering.dispose();
  }
}
