import * as THREE from "three";
import { SPLAT_TEX_WIDTH } from "../../data/defines";
import type { SplatMapping } from "../../rendering/SplatAccumulator";
import type { SplatMesh } from "../../scene/SplatMesh";

/** log2 of the flags texture's width; webgl/surfaceVertex.glsl spells it out. */
export const LIGHT_FLAGS_WIDTH_BITS = 12;
const FLAGS_TEXTURE_WIDTH = 1 << LIGHT_FLAGS_WIDTH_BITS;

export type GetLightFlags = (mesh: SplatMesh) => number;

/**
 * Light flags of the models in a WebGL accumulator: one texel per row, since
 * each model's range starts on a row. Native WebGPU caches flags per Splat.
 */
export class LightFlagsTexture {
  private texture: THREE.DataTexture | null = null;

  constructor(private readonly flagsOf: GetLightFlags) {}

  update(mapping: readonly SplatMapping[], numSplats: number) {
    const rows = Math.ceil(numSplats / SPLAT_TEX_WIDTH);
    const height = Math.max(1, Math.ceil(rows / FLAGS_TEXTURE_WIDTH));
    let texture = this.texture;
    let changed = false;
    if (texture?.image.height !== height) {
      texture?.dispose();
      texture = this.texture = new THREE.DataTexture(
        new Uint32Array(FLAGS_TEXTURE_WIDTH * height),
        FLAGS_TEXTURE_WIDTH,
        height,
        THREE.RedIntegerFormat,
        THREE.UnsignedIntType,
      );
      changed = true;
    }
    const data = texture.image.data as Uint32Array;
    for (const { node, base, count } of mapping) {
      const flags = this.flagsOf(node);
      const end = Math.ceil((base + count) / SPLAT_TEX_WIDTH);
      for (let row = base / SPLAT_TEX_WIDTH; row < end; row++) {
        changed ||= data[row] !== flags;
        data[row] = flags;
      }
    }
    if (changed) texture.needsUpdate = true;
    return texture;
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
  }
}
