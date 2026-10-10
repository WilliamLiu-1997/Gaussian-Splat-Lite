import { IndexedSplats } from "./IndexedSplats.js";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "./defines.js";
import { resetSplatBounds, unionSplatBounds } from "./splatData.js";
import { getTextureSize } from "./textureLayout.js";
// Small allocation blocks avoid a separate 2048-Splat texture row per region.
const BLOCK_BITS = 6;
const BLOCK_SIZE = 1 << BLOCK_BITS;
const MIN_LAYER_SIZE = 8192;
export function sogBatchAllocationSize(count) {
  return Math.ceil(count / BLOCK_SIZE) * BLOCK_SIZE;
}
export function sogBatchTextureLayout(count) {
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
  constructor(count, numSh) {
    const { capacity, layerSize } = sogBatchTextureLayout(count);
    super({ capacity, layerSize, numSh, blockBits: BLOCK_BITS });
    this.activeRanges = new Map();
    this.indicesDirty = false;
    this.boundsDirty = true;
    this.regionBounds = new Map();
  }
  write(start, data) {
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
  setOpacity(start, count, opacity) {
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
  release(start) {
    this.assertLive();
    this.regionBounds.delete(start);
    this.releaseSpatialBounds(start);
  }
  getBoundingBox(centersOnly = true, target = undefined) {
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
  getByteLength() {
    return super.getByteLength() + this.regionBounds.size * 48;
  }
  ensureIndices() {
    if (!this.indicesDirty) return;
    const indices = this.prepareIndices(this.numSplats);
    let target = 0;
    for (const [start, count] of this.activeRanges)
      for (let source = start; source < start + count; source++) {
        this.visibleIndices[source] = target;
        indices[target++] = source;
      }
    this.indicesDirty = false;
  }
  dispose() {
    super.dispose();
    this.activeRanges.clear();
    this.regionBounds.clear();
    this.indicesDirty = false;
  }
}
