import { MaterialState } from "../rendering/MaterialState.js";
import { createStochasticSplatVariant } from "../rendering/StochasticSplatMaterial.js";
import { usesNativeWebGPU } from "../rendering/rendererUtils.js";

/** Four coverage decisions in one fragment, resolved by 4x MSAA. */
export class StochasticCoverage {
  materials = new Map();
  material(source, renderer) {
    let entry = this.materials.get(source);
    if (!entry) {
      const variant = createStochasticSplatVariant(source, renderer);
      if (!variant) return source;
      const dispose = () => {
        source.removeEventListener("dispose", dispose);
        variant.dispose();
        this.materials.delete(source);
      };
      entry = { variant, state: new MaterialState(source), dispose };
      this.materials.set(source, entry);
      source.addEventListener("dispose", dispose);
    }
    entry.state.sync(entry.variant, source);
    return entry.variant;
  }
  render(renderer, scene, camera) {
    if (
      !usesNativeWebGPU(renderer) &&
      !renderer.getContext().getExtension("OES_sample_variables")
    )
      throw new Error(
        "Stochastic rendering with MSAA requires OES_sample_variables on WebGL2; use msaa = false on this device",
      );
    const nodeRenderer = renderer.isWebGPURenderer === true;
    const previous = nodeRenderer
      ? renderer.getRenderObjectFunction()
      : renderer.renderBufferDirect;
    const draw = previous ?? renderer.renderObject;
    // renderObject receives material at index 4; renderBufferDirect at 3.
    // Keep object.material intact throughout scene and object callbacks.
    const materialIndex = nodeRenderer ? 4 : 3;
    const hook = (...args) => {
      args[materialIndex] = this.material(args[materialIndex], renderer);
      return draw.apply(renderer, args);
    };
    if (nodeRenderer) renderer.setRenderObjectFunction(hook);
    else renderer.renderBufferDirect = hook;
    try {
      renderer.render(scene, camera);
    } finally {
      if (nodeRenderer) renderer.setRenderObjectFunction(previous);
      else renderer.renderBufferDirect = previous;
    }
  }
  dispose() {
    for (const entry of this.materials.values()) entry.dispose();
  }
}
