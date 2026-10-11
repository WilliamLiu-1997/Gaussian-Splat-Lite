import type { Material } from "three";
import type { GaussianSplatCompatibleRenderer } from "./rendererUtils.js";

/** Registers a stochastic material's four-sample variant factory. */
export declare function registerStochasticSplatMaterial(
  material: Material,
  createVariant: (renderer: GaussianSplatCompatibleRenderer) => Material,
): void;

/** Shares the Splat shader and uniforms, adding four-sample coverage. */
export declare function createStochasticSplatVariant(
  material: Material,
  renderer: GaussianSplatCompatibleRenderer,
): Material | null;
