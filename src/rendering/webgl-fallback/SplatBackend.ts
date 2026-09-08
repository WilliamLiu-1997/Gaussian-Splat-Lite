import * as THREE from "three";
import { textureLoad } from "three/tsl";
import type { WebGPURenderer } from "three/webgpu";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { NodeSplatBackend } from "../tsl/SplatBackend";
import type { SplatNodeMaterial } from "../tsl/SplatMaterial";
import {
  ORDERING_TEXTURE_WIDTH,
  SPLATS_PER_ORDERING_ROW,
  type Uniforms,
  emptyOrdering,
} from "../uniforms";
import { installWebGLFallbackCompatibilityPatches } from "./compatibility";

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
  private ordering: THREE.DataTexture | null = null;

  constructor(
    renderer: WebGPURenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    super(renderer, uniforms, options, textureLoad(emptyOrdering));
    installWebGLFallbackCompatibilityPatches(renderer);
  }

  getOrderingCapacity(count: number) {
    return (
      Math.max(1, Math.ceil(count / SPLATS_PER_ORDERING_ROW)) *
      SPLATS_PER_ORDERING_ROW
    );
  }

  get cpuOrdering(): Uint32Array | null {
    return (this.ordering?.image.data as Uint32Array | null) ?? null;
  }

  setCPUOrdering({
    ordering,
    activeSplats,
    requiredCapacity,
    shrink,
  }: CPUOrderingUpdate) {
    const rows = requiredCapacity / SPLATS_PER_ORDERING_ROW;
    if (
      this.ordering &&
      (rows > this.ordering.image.height ||
        (shrink && rows !== this.ordering.image.height))
    ) {
      this.ordering.dispose();
      this.ordering = null;
    }
    if (!this.ordering) {
      this.ordering = new THREE.DataTexture(
        ordering,
        ORDERING_TEXTURE_WIDTH,
        rows,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
      );
      this.ordering.needsUpdate = true;
    } else {
      this.ordering.image.data = ordering;
      if (activeSplats > 0) {
        // Finish any pending allocation before uploading only active rows.
        this.renderer.initTexture(this.ordering);
        // The pinned fallback's copyTextureToTexture allocates a GPU source;
        // update the destination directly to avoid that staging texture.
        const backend = this.renderer
          .backend as unknown as TextureUploadBackend;
        backend.updateTexture(this.ordering, {
          width: ORDERING_TEXTURE_WIDTH,
          height: Math.ceil(activeSplats / SPLATS_PER_ORDERING_ROW),
          image: this.ordering.image,
        });
      }
    }
    this.material.orderingNode.value = this.ordering;
  }

  dispose() {
    this.ordering?.dispose();
    this.ordering = null;
  }

  bindOrdering(material: SplatMaterial, _uniforms: Uniforms) {
    (material as SplatNodeMaterial).orderingNode.value =
      this.ordering ?? emptyOrdering;
  }
}
