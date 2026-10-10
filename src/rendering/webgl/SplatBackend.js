import { MaterialVariants } from "../MaterialVariants.js";
import { emptyOrdering } from "../uniforms.js";
import { OrderingTexture } from "./OrderingTexture.js";
import { createWebGLSplatMaterial } from "./SplatMaterial.js";
import { uploadU32DataTextureRows } from "./textureUtils.js";
/** WebGL materials and ordering-texture uploads. */
export class WebGLSplatBackend {
  constructor(renderer, uniforms, options) {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.kind = "webgl";
    this.ordering = new OrderingTexture();
    this.materials = new MaterialVariants((stochastic, shading) =>
      createWebGLSplatMaterial(uniforms, options, stochastic, shading),
    );
    const extension = renderer
      .getContext()
      .getExtension("WEBGL_provoking_vertex");
    extension?.provokingVertexWEBGL(extension.FIRST_VERTEX_CONVENTION_WEBGL);
  }
  /** `shading`, when given, selects the variant that recolors its Splats. */
  selectMaterial(stochastic, shading) {
    return this.materials.select(stochastic, shading);
  }
  getOrderingCapacity(count) {
    return this.ordering.getCapacity(count);
  }
  get cpuOrdering() {
    return this.ordering.data;
  }
  setCPUOrdering(update) {
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
    this.materials.dispose();
  }
}
