import type * as THREE from "three";
import type { CPUOrderingUpdate, SplatMaterialOptions } from "../backend";
import { type Uniforms, emptyOrdering } from "../uniforms";
import { OrderingTexture } from "./OrderingTexture";
import { createWebGLSplatMaterial } from "./SplatMaterial";
import { uploadU32DataTextureRows } from "./textureUtils";

/** WebGL materials and ordering-texture uploads. */
export class WebGLSplatBackend {
  readonly kind = "webgl";
  readonly material: THREE.ShaderMaterial;
  private readonly ordering = new OrderingTexture();

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

  selectMaterial(stochastic: boolean) {
    const { material } = this;
    const value = Number(stochastic);
    if (material.defines.GSL_STOCHASTIC !== value) {
      material.defines.GSL_STOCHASTIC = value;
      material.needsUpdate = true;
    }
    return material;
  }

  getOrderingCapacity(count: number) {
    return this.ordering.getCapacity(count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering.data;
  }

  setCPUOrdering(update: CPUOrderingUpdate) {
    this.uniforms.ordering.value = this.ordering.update(
      update,
      (texture, rows) => {
        uploadU32DataTextureRows(
          this.renderer,
          texture,
          texture.image.width,
          rows,
          update.ordering,
        );
      },
    );
  }

  /** Unsorted draws read no ordering; the next sort allocates it again. */
  releaseOrdering() {
    this.ordering.dispose();
    this.uniforms.ordering.value = emptyOrdering;
  }

  dispose() {
    this.ordering.dispose();
    this.material.dispose();
  }
}
