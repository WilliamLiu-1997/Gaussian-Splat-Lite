import { IndexedSplats } from "./IndexedSplats";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH, type SplatResult } from "./defines";
import { getTextureSize } from "./textureLayout";

// Small allocation blocks avoid a separate 2048-Splat texture row per region.
const BLOCK_BITS = 6;
const BLOCK_SIZE = 1 << BLOCK_BITS;
const MIN_LAYER_SIZE = 8192;

export function sogBatchAllocationSize(count: number) {
  return Math.ceil(count / BLOCK_SIZE) * BLOCK_SIZE;
}

export function sogBatchTextureLayout(count: number) {
  // Grow the layer dimensions instead of splitting a chunk into more Meshes.
  // Keep the same backing-array alignment as Splats to avoid a second copy.
  const aligned = getTextureSize(count).maxSplats;
  const layerSize = Math.min(
    SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT,
    Math.max(MIN_LAYER_SIZE, 2 ** Math.ceil(Math.log2(aligned / 256))),
  );
  return {
    capacity: Math.ceil(aligned / layerSize) * layerSize,
    layerSize,
  };
}

/** Independently visible regions in fixed source slots. */
export class SogRegionSplats extends IndexedSplats {
  private readonly activeRanges = new Map<number, number>();
  private indicesDirty = false;

  constructor(count: number, numSh: number) {
    const { capacity, layerSize } = sogBatchTextureLayout(count);
    super({ capacity, layerSize, numSh, blockBits: BLOCK_BITS });
  }

  write(start: number, data: SplatResult) {
    if (start % BLOCK_SIZE !== 0)
      throw new Error("SOG region slot must be block aligned");
    this.writeRecords(start, data, sogBatchAllocationSize(data.numSplats));
  }

  setOpacity(start: number, count: number, opacity: number) {
    this.assertLive();
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start % BLOCK_SIZE !== 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      start + sogBatchAllocationSize(count) > this.maxSplats ||
      !Number.isFinite(opacity) ||
      opacity < 0 ||
      opacity > 1
    )
      throw new Error("Invalid SOG region opacity range");
    const previous = this.opacities.getOpacity(start);
    if (!this.opacities.setOpacity(start, count, opacity)) return;
    const visible = Math.fround(opacity) > 0;
    const visibilityChanged = previous > 0 !== visible;
    if (visibilityChanged) {
      if (visible) this.activeRanges.set(start, count);
      else this.activeRanges.delete(start);
      this.numSplats += visible ? count : -count;
      this.indicesDirty = true;
    }
    return { visibilityChanged };
  }

  protected override ensureIndices() {
    if (!this.indicesDirty) return;
    const indices = new Uint32Array(this.numSplats);
    let target = 0;
    for (const [start, count] of this.activeRanges)
      for (let source = start; source < start + count; source++)
        indices[target++] = source;
    this.commitIndices(indices);
    this.indicesDirty = false;
  }

  override dispose() {
    super.dispose();
    this.activeRanges.clear();
    this.indicesDirty = false;
  }
}
