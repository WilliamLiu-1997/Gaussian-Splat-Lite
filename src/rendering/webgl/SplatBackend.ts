import * as THREE from "three";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { type Uniforms, emptyOrdering } from "../uniforms";
import { createWebGLLayers } from "./LayeredOverdraw";
import { OrderingTexture } from "./OrderingTexture";
import { createWebGLSplatMaterial } from "./SplatMaterial";
import { uploadU32DataTextureRows } from "./textureUtils";

/** WebGL materials, ordering-texture uploads, and framebuffer readback. */
export class WebGLSplatBackend {
  readonly kind = "webgl";
  readonly material: THREE.ShaderMaterial;
  private readonly ordering = new OrderingTexture();
  private layeredState: ReturnType<typeof createWebGLLayers> | null = null;

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    private readonly uniforms: Uniforms,
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
    const sorted = Number(!useUniform);
    if (material.defines.GSL_SORTED_FRAGMENT !== sorted) {
      material.defines.GSL_SORTED_FRAGMENT = sorted;
      material.needsUpdate = true;
    }
    return material;
  }

  /** Front-to-back layer passes, created on first use; the material composites them. */
  get layered() {
    this.layeredState ??= createWebGLLayers(this.renderer, this.uniforms);
    return { overdraw: this.layeredState.overdraw, material: this.material };
  }

  /** Compiles the composite branch only while layered overdraw is enabled. */
  setLayered(enabled: boolean) {
    const { material } = this;
    const composite = Number(enabled);
    if (material.defines.GSL_LAYERED_COMPOSITE !== composite) {
      material.defines.GSL_LAYERED_COMPOSITE = composite;
      material.needsUpdate = true;
    }
  }

  /** Releases layer targets while layered overdraw is disabled. */
  releaseLayered() {
    this.layeredState?.overdraw.release();
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
    this.layeredState?.dispose();
    this.layeredState = null;
    this.ordering.dispose();
    this.material.dispose();
  }
}
