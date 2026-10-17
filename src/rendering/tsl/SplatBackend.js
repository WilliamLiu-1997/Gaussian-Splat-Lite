import { createSplatNodeMaterial } from "./SplatMaterial.js";
/** Drawing shared by both WebGPURenderer backends. */
export class NodeSplatBackend {
  constructor(renderer, uniforms, options, orderingNode, vertexData) {
    this.renderer = renderer;
    this.createMaterial = (stochastic, effect) =>
      createSplatNodeMaterial({
        uniforms,
        ...options,
        orderingNode,
        vertexData,
        stochastic,
        effect,
      });
    this.setEffect(null);
  }
  setEffect(effect) {
    const sorted = this.createMaterial(false, effect);
    const stochastic = this.createMaterial(true, effect);
    this.sortedMaterial?.dispose();
    this.stochasticMaterial?.dispose();
    this.sortedMaterial = sorted;
    this.stochasticMaterial = stochastic;
  }
  selectMaterial(stochastic) {
    return stochastic ? this.stochasticMaterial : this.sortedMaterial;
  }
  dispose() {
    this.sortedMaterial.dispose();
    this.stochasticMaterial.dispose();
  }
}
