import type * as THREE from "three";
import type { TextureNode, WebGPURenderer } from "three/webgpu";
import type { CPUOrderingUpdate, SplatMaterialOptions } from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import { uintTexture } from "../tsl/tslCompat";
import { type Uniforms, emptyOrdering } from "../uniforms";
import { OrderingTexture } from "../webgl/OrderingTexture";

type TextureUploadBackend = {
  updateTexture(
    texture: THREE.DataTexture,
    options: {
      width: number;
      height: number;
      image: THREE.DataTexture["image"];
    },
  ): void;
};

/** TSL drawing with CPU-sorted indices stored in an integer texture. */
export class WebGLFallbackSplatBackend extends NodeSplatBackend {
  readonly kind = "webgl-fallback";
  private readonly ordering = new OrderingTexture();
  // Shared by the sorted and stochastic materials.
  private readonly orderingNode: TextureNode<"uvec4">;

  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    const orderingNode = uintTexture(emptyOrdering);
    super(renderer, uniforms, options, orderingNode);
    this.orderingNode = orderingNode;
  }

  getOrderingCapacity(count: number) {
    return this.ordering.getCapacity(count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering.data;
  }

  setCPUOrdering(update: CPUOrderingUpdate) {
    this.orderingNode.value = this.ordering.update(update, (texture, rows) => {
      // Finish any pending allocation before uploading only active rows.
      this.renderer.initTexture(texture);
      // Update the destination directly to avoid copyTextureToTexture's
      // GPU staging texture.
      const backend = this.renderer.backend as unknown as TextureUploadBackend;
      backend.updateTexture(texture, {
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
