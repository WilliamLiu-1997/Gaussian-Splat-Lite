import { MaterialVariants } from "../MaterialVariants.js";
import { createSplatNodeMaterial } from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  constructor(renderer, uniforms, options, orderingNode, vertexData) {
    this.renderer = renderer;
    this.materials = new MaterialVariants((stochastic, shading) =>
      createSplatNodeMaterial({
        uniforms,
        ...options,
        orderingNode,
        vertexData,
        stochastic,
        shading,
      }),
    );
  }
  /** `shading`, when given, selects the variant that recolors its Splats. */
  selectMaterial(stochastic, shading) {
    return this.materials.select(stochastic, shading);
  }
  dispose() {
    this.materials.dispose();
  }
}
