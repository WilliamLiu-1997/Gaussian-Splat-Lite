import type { Box3 } from "three";
import { IndexedSplats } from "./IndexedSplats";
import {
  type ReorderedSplatResult,
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines";
import { resetSplatBounds, unionSplatBounds } from "./splatData";
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
  private boundsDirty = true;
  private readonly regionBounds = new Map<
    number,
    { centers: Float32Array; full: Float32Array }
  >();

  constructor(count: number, numSh: number) {
    const { capacity, layerSize } = sogBatchTextureLayout(count);
    super({ capacity, layerSize, numSh, blockBits: BLOCK_BITS });
  }

  write(start: number, data: ReorderedSplatResult) {
    if (
      data.centerOnlyBoundingBox?.length !== 6 ||
      data.boundingBox?.length !== 6
    )
      throw new Error("SOG region bounds must contain six values");
    this.writeRecords(start, data, sogBatchAllocationSize(data.numSplats));
    this.regionBounds.set(start, {
      centers: data.centerOnlyBoundingBox.slice(),
      full: data.boundingBox.slice(),
    });
    if (this.activeRanges.has(start)) this.boundsDirty = true;
  }

  setOpacity(start: number, count: number, opacity: number) {
    this.assertLive();
    // The scheduler supplies block-aligned slots and clamped fade values.
    const previous = this.opacities.getOpacity(start);
    if (!this.opacities.setOpacity(start, count, opacity)) return;
    const visible = Math.fround(opacity) > 0;
    const visibilityChanged = previous > 0 !== visible;
    if (visibilityChanged) {
      if (visible) this.activeRanges.set(start, count);
      else this.activeRanges.delete(start);
      this.numSplats += visible ? count : -count;
      this.indicesDirty = true;
      this.boundsDirty = true;
    }
    return { visibilityChanged };
  }

  /** The batch hides the region before releasing its slot. */
  release(start: number) {
    this.assertLive();
    this.regionBounds.delete(start);
  }

  override getBoundingBox(centersOnly = true, target?: Box3) {
    this.assertLive();
    if (this.boundsDirty) {
      resetSplatBounds(this.centerOnlyBounds);
      resetSplatBounds(this.bounds);
      for (const start of this.activeRanges.keys()) {
        const bounds = this.regionBounds.get(start);
        if (!bounds) throw new Error("Visible SOG region has no cached bounds");
        unionSplatBounds(this.centerOnlyBounds, bounds.centers);
        unionSplatBounds(this.bounds, bounds.full);
      }
      this.boundsDirty = false;
    }
    return super.getBoundingBox(centersOnly, target);
  }

  override getByteLength() {
    return super.getByteLength() + this.regionBounds.size * 48;
  }

  protected override ensureIndices() {
    if (!this.indicesDirty) return;
    const indices = this.prepareIndices(this.numSplats);
    let target = 0;
    for (const [start, count] of this.activeRanges)
      for (let source = start; source < start + count; source++)
        indices[target++] = source;
    this.indicesDirty = false;
  }

  override dispose() {
    super.dispose();
    this.activeRanges.clear();
    this.regionBounds.clear();
    this.indicesDirty = false;
  }
}
