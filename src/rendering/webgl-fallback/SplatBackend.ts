import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import type { SplatNodeMaterial } from "../tsl/SplatMaterial";
import { uintTexture } from "../tsl/tslCompat";
import { type Uniforms, emptyOrdering } from "../uniforms";
import { OrderingTexture } from "../webgl/OrderingTexture";
import { createFallbackLayers } from "./LayeredOverdraw";

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
  private layeredState: ReturnType<typeof createFallbackLayers> | null = null;

  constructor(
    renderer: WebGPURenderer,
    private readonly uniforms: Uniforms,
    private readonly options: SplatMaterialOptions,
  ) {
    super(renderer, uniforms, options, uintTexture(emptyOrdering));
  }

  /** Front-to-back layer passes and their composite, created on first use. */
  get layered() {
    this.layeredState ??= createFallbackLayers(
      this.renderer,
      this.uniforms,
      this.options,
      this.sortedMaterial.orderingNode,
    );
    return this.layeredState;
  }

  /** Releases layer targets while layered overdraw is disabled. */
  releaseLayered() {
    this.layeredState?.overdraw.release();
  }

  getOrderingCapacity(count: number) {
    return this.ordering.getCapacity(count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering.data;
  }

  setCPUOrdering(update: CPUOrderingUpdate) {
    this.sortedMaterial.orderingNode.value = this.ordering.update(
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
    super.dispose();
    this.layeredState?.dispose();
    this.layeredState = null;
    this.ordering.dispose();
  }

  bindOrdering(material: SplatMaterial, _uniforms: Uniforms) {
    (material as SplatNodeMaterial).orderingNode.value =
      this.ordering.texture ?? emptyOrdering;
  }
}
