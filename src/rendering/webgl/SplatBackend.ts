import * as THREE from "three";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { type Uniforms, emptyOrdering } from "../uniforms";
import { OrderingTexture } from "./OrderingTexture";
import { createWebGLSplatMaterial } from "./SplatMaterial";
import { uploadU32DataTextureRows } from "./textureUtils";

/** WebGL materials, ordering-texture uploads, and framebuffer readback. */
export class WebGLSplatBackend {
  readonly kind = "webgl";
  readonly material: THREE.ShaderMaterial;
  private readonly ordering = new OrderingTexture();

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    this.material = createWebGLSplatMaterial(uniforms, options);
    const extension = renderer
      .getContext()
      .getExtension("WEBGL_provoking_vertex");
    extension?.provokingVertexWEBGL(extension.FIRST_VERTEX_CONVENTION_WEBGL);
  }

  selectMaterial(useUniform: boolean) {
    const { material } = this;
    const currentSorted = material.defines.GSL_SORTED_FRAGMENT;
    const sorted = Number(!useUniform);
    // Custom shaders keep their defines; built-in variants share the program cache.
    if (currentSorted !== undefined && currentSorted !== sorted) {
      material.defines.GSL_SORTED_FRAGMENT = sorted;
      material.needsUpdate = true;
    }
    return material;
  }

  createDepthMaterial(uniforms: Uniforms) {
    return createWebGLSplatMaterial(uniforms, {
      premultipliedAlpha: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
  }

  getOrderingCapacity(count: number) {
    return this.ordering.getCapacity(count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering.data;
  }

  setCPUOrdering(update: CPUOrderingUpdate) {
    this.ordering.update(update, (texture, rows) => {
      uploadU32DataTextureRows(
        this.renderer,
        texture,
        texture.image.width,
        rows,
        update.ordering,
      );
    });
  }

  bindOrdering(_material: SplatMaterial, uniforms: Uniforms) {
    uniforms.ordering.value = this.ordering.texture ?? emptyOrdering;
  }

  async readPixels(
    target: THREE.WebGLRenderTarget,
    pixels: Uint8Array,
    face = 0,
  ) {
    await this.renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
      pixels,
      face,
    );
  }

  createPMREMGenerator() {
    return new THREE.PMREMGenerator(this.renderer);
  }

  dispose() {
    this.ordering.dispose();
    this.material.dispose();
  }
}
