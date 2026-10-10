import { createSplatNodeMaterial } from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  constructor(renderer, uniforms, options, orderingNode, vertexData) {
    this.renderer = renderer;
    const create = (stochastic) =>
      createSplatNodeMaterial({
        uniforms,
        ...options,
        orderingNode,
        vertexData,
        stochastic,
      });
    this.sortedMaterial = create(false);
    this.stochasticMaterial = create(true);
  }
  selectMaterial(stochastic) {
    return stochastic ? this.stochasticMaterial : this.sortedMaterial;
  }
  dispose() {
    this.sortedMaterial.dispose();
    this.stochasticMaterial.dispose();
  }
}
