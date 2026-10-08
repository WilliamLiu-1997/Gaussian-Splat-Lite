import type * as THREE from "three";
import type { NodeSplatBackend } from "../../../rendering/tsl/SplatBackend";
import type { SplatNodeMaterial } from "../../../rendering/tsl/SplatMaterial";
import {
  textureBinding,
  uniformBinding,
} from "../../../rendering/tsl/shaderUtils";
import { type Uniforms, emptyOrdering } from "../../../rendering/uniforms";
import type { SceneLights } from "../SceneLights";
import { createLitShading } from "./shading";

/**
 * The lit Splat materials of the WebGPURenderer backends: one for sorted and
 * one for stochastic draws, built when first drawn. Unlit draws keep the
 * materials they always had.
 */
export class NodeLitMaterials {
  // By stochastic flag.
  private readonly materials: (SplatNodeMaterial | undefined)[] = [];
  private readonly shading: ReturnType<typeof createLitShading>;
  private readonly placeholders: THREE.Texture[] = [];
  // Light flags of each accumulator row; see LightFlags.ts.
  private readonly flags: Uniforms = { splatFlags: { value: emptyOrdering } };
  private shape: string | null = null;
  private epoch = 0;

  constructor(
    private readonly backend: NodeSplatBackend,
    uniforms: Uniforms,
    lights: SceneLights,
    /** Whether draws read an accumulator, which holds no light flags. */
    accumulator: boolean,
    /** A draw is about to use a shader that no longer fits the lights. */
    onStale: () => void,
  ) {
    this.shading = createLitShading({
      lights,
      encodeLinear: uniformBinding(uniforms, "encodeLinear", "bool"),
      flags: accumulator
        ? textureBinding(this.flags, "splatFlags", this.placeholders)
        : null,
      renderer: backend.renderer,
      cacheKey: () => String(this.epoch),
      onStale,
    });
  }

  select(stochastic: boolean) {
    this.materials[Number(stochastic)] ??= this.backend.createMaterial(
      stochastic,
      this.shading,
    );
    return this.materials[Number(stochastic)] as SplatNodeMaterial;
  }

  /**
   * Has the shaders rebuilt when the scene's lights take another shape, or
   * `null` when it could have changed unseen. Three.js rebuilds them as
   * well, but keeps a shader for each list of lights it has drawn, and one
   * kept from before would still update shadow maps Three.js has released
   * since.
   */
  refresh(shape: string | null) {
    if (shape !== null && shape === this.shape) return;
    this.shape = shape;
    this.epoch++;
    for (const material of this.materials)
      if (material) material.needsUpdate = true;
  }

  /**
   * Lighting is off: frees the variance maps lit draws blur. The shaders
   * that read them are rebuilt once lighting follows a scene again.
   */
  release() {
    this.shading.dispose();
  }

  setFlags(flags: THREE.Texture) {
    this.flags.splatFlags.value = flags;
  }

  dispose() {
    for (const material of this.materials) material?.dispose();
    this.materials.length = 0;
    this.shading.dispose();
    for (const texture of this.placeholders) texture.dispose();
  }
}
