const variants = new WeakMap();

/** Registers a stochastic material's four-sample variant factory. */
export function registerStochasticSplatMaterial(material, createVariant) {
  variants.set(material, createVariant);
}

/** Shares the Splat shader and uniforms, adding four-sample coverage. */
export function createStochasticSplatVariant(material, renderer) {
  return variants.get(material)?.(renderer) ?? null;
}
