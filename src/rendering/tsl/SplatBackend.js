import { createSplatNodeMaterial } from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  constructor(renderer, uniforms, options, orderingNode, vertexData) {
    this.renderer = renderer;
    this.createMaterial = (stochastic, modifier) =>
      createSplatNodeMaterial({
        uniforms,
        modifier,
        ...options,
        orderingNode,
        vertexData,
        stochastic,
      });
    this.sortedMaterial = this.createMaterial(false);
    this.stochasticMaterial = this.createMaterial(true);
  }
  selectMaterial(stochastic) {
    return stochastic ? this.stochasticMaterial : this.sortedMaterial;
  }
  dispose() {
    this.sortedMaterial.dispose();
    this.stochasticMaterial.dispose();
  }
}
