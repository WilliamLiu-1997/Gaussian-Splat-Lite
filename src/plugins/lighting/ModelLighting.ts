import type { Object3D } from "three";

export type SplatModelLightingOptions = {
  receiveLight?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

/** Per-model settings, inherited by streamed batches and other descendants. */
export class ModelLighting {
  private readonly options = new WeakMap<Object3D, SplatModelLightingOptions>();

  set(model: Object3D, options: SplatModelLightingOptions) {
    this.options.set(model, { ...this.options.get(model), ...options });
    if (options.castShadow !== undefined) model.castShadow = options.castShadow;
    if (options.receiveShadow !== undefined)
      model.receiveShadow = options.receiveShadow;
  }

  /** Bits: receive light, receive shadows, cast shadows. */
  flags(model: Object3D) {
    let flags =
      1 | (Number(model.receiveShadow) << 1) | (Number(model.castShadow) << 2);
    let remaining = 7;
    for (
      let node: Object3D | null = model;
      node && remaining;
      node = node.parent
    ) {
      const options = this.options.get(node);
      if (!options) continue;
      if ((remaining & 1) !== 0 && options.receiveLight !== undefined) {
        flags = options.receiveLight ? flags | 1 : flags & ~1;
        remaining &= ~1;
      }
      if ((remaining & 2) !== 0 && options.receiveShadow !== undefined) {
        flags = node.receiveShadow ? flags | 2 : flags & ~2;
        remaining &= ~2;
      }
      if ((remaining & 4) !== 0 && options.castShadow !== undefined) {
        flags = node.castShadow ? flags | 4 : flags & ~4;
        remaining &= ~4;
      }
    }
    return flags;
  }
}
