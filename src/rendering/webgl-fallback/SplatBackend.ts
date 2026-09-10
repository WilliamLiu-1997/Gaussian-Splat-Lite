import type * as THREE from "three";
import { textureLoad } from "three/tsl";
import type { WebGPURenderer } from "three/webgpu";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import type { SplatNodeMaterial } from "../tsl/SplatMaterial";
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

  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    super(renderer, uniforms, options, textureLoad(emptyOrdering));
  }

  getOrderingCapacity(count: number) {
    return this.ordering.getCapacity(count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering.data;
  }

  setCPUOrdering(update: CPUOrderingUpdate) {
    this.material.orderingNode.value = this.ordering.update(
      update,
      (texture, rows) => {
        // Finish any pending allocation before uploading only active rows.
        this.renderer.initTexture(texture);
        // The r186 fallback's copyTextureToTexture allocates a GPU source;
        // update the destination directly to avoid that staging texture.
        const backend = this.renderer
          .backend as unknown as TextureUploadBackend;
        backend.updateTexture(texture, {
          width: texture.image.width,
          height: rows,
          image: texture.image,
        });
      },
    );
  }

  dispose() {
    this.ordering.dispose();
  }

  bindOrdering(material: SplatMaterial, _uniforms: Uniforms) {
    (material as SplatNodeMaterial).orderingNode.value =
      this.ordering.texture ?? emptyOrdering;
  }
}
