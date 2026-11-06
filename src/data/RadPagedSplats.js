import { IndexedSplats } from "./IndexedSplats.js";
import { RAD_PAGE_SIZE, RAD_POOL_PAGE_COUNT } from "./defines.js";
function lowerBound(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** Eight shared 65,536-record RAD slots, one page per texture array layer. */
export class RadPagedSplats extends IndexedSplats {
  constructor({ numSh, indexedSh = false, deferAllocation = false }) {
    super({
      capacity: RAD_POOL_PAGE_COUNT * RAD_PAGE_SIZE,
      layerSize: RAD_PAGE_SIZE,
      numSh,
      indexedSh,
      blockBits: 0,
      packedOpacityGroups: true,
      deferAllocation,
    });
    this.fadeProgress = 1;
    this.fadeKinds = 0;
    this.pageCount = RAD_POOL_PAGE_COUNT;
    this.selectedPages = new Uint32Array(this.pageCount);
  }
  /** Copies data and zeros SH above numSh; callers retain the packed buffers. */
  writePage(slot, data, numSh) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.pageCount)
      throw new Error("Invalid RAD page slot");
    this.writeRecords(slot * RAD_PAGE_SIZE, data, RAD_PAGE_SIZE, numSh);
  }
  releasePage(slot) {
    this.releaseSpatialBounds(slot * RAD_PAGE_SIZE);
    this.selectedPages[slot] = 0;
    if (this.finalSelectedPages) this.finalSelectedPages[slot] = 0;
  }
  /** Copy a resident page into a free slot in one pass.
   * The scheduler publishes its selection only after all copies are uploaded. */
  copyPage(source, previous, slot) {
    const start = previous * RAD_PAGE_SIZE;
    const target = slot * RAD_PAGE_SIZE;
    const spatial = source.spatialChunks.get(start);
    this.spatialChunks.set(target, spatial);
    this.spatialBoundsBytes += spatial.bounds.byteLength;
    for (const [index, array] of source.sourceArrays.entries()) {
      const stride = array.length / source.maxSplats;
      this.sourceArrays[index].set(
        array.subarray(start * stride, (start + RAD_PAGE_SIZE) * stride),
        target * stride,
      );
      this.sourceTextures[index].addLayerUpdate(slot);
      this.sourceTextures[index].needsUpdate = true;
    }
    this.uploadQueue?.add(this);
  }
  /** Remove the displayed cut when its scheduler becomes hidden. */
  clearSelection() {
    this.assertLive();
    this.selectedPages.fill(0);
    this.finalSelectedPages = undefined;
    this.fadeKinds = 0;
    this.fadeProgress = 1;
    this.opacities.setGroupOpacity(2, 1);
    this.opacities.setGroupOpacity(3, 1);
  }
  /** Never transfer live texture storage to the preparation worker. */
  snapshotSelection(ranges) {
    this.assertLive();
    return {
      pageCount: this.pageCount,
      opacityBlocks: this.opacities.copyBlocks(),
      ranges,
    };
  }
  /** Internal commit of worker-prepared data; views commit each input's cut. */
  commitSelection(prepared) {
    this.selectedPages = prepared.selectedPages;
    this.finalSelectedPages = prepared.finalSelectedPages;
    this.fadeKinds = prepared.fadeKinds;
    this.fadeProgress = this.fadeKinds ? 0 : 1;
    this.opacities.setGroupOpacity(2, this.fadeKinds ? 0 : 1);
    this.opacities.setGroupOpacity(3, 1);
    this.opacities.commitBlocks(prepared.opacityBlocks, prepared.dirtyLayers);
  }
  /** A normal streaming fade changes only two group coefficients. */
  setFadeProgress(progress) {
    this.assertLive();
    if (progress === this.fadeProgress) return false;
    this.fadeProgress = progress;
    if (!this.fadeKinds) return false;
    const fadeIn = this.opacities.setGroupOpacity(2, progress);
    const fadeOut = this.opacities.setGroupOpacity(3, 1 - progress);
    return (
      (!!(this.fadeKinds & 1) && fadeIn) || (!!(this.fadeKinds & 2) && fadeOut)
    );
  }
  isPageSelected(slot) {
    return this.selectedPages[slot] > 0;
  }
  /** Complete opacity changes; views remove outgoing records themselves. */
  finishFade() {
    const changed = this.setFadeProgress(1);
    if (this.finalSelectedPages) this.selectedPages = this.finalSelectedPages;
    this.finalSelectedPages = undefined;
    this.fadeKinds = 0;
    return changed;
  }
  getByteLength() {
    return (
      super.getByteLength() +
      (this.finalSelectedPages?.byteLength ?? 0) +
      this.selectedPages.byteLength
    );
  }
  dispose() {
    super.dispose();
    this.selectedPages = new Uint32Array(0);
    this.finalSelectedPages = undefined;
  }
}
/**
 * One input's selected records across the shared page pool. Cuts list records
 * in ascending storage order, so picking needs no pool-sized reverse map.
 */
export class RadPageView extends IndexedSplats {
  constructor(storage, palette) {
    super({ storage, palette });
    this.finalCut = undefined;
  }
  forEachRaycastRange(query, callback) {
    this.assertLive();
    const indices = this.sourceIndices.subarray(0, this.numSplats);
    let rangeStart = -1;
    let rangeEnd = -1;
    for (const [start, { count, bounds }] of this.spatialChunks) {
      // Most pages may belong to other inputs or be outside this input's cut.
      if (lowerBound(indices, start) === lowerBound(indices, start + count))
        continue;
      query.forEachRange(bounds, count, (base, length) => {
        const first = lowerBound(indices, start + base);
        const last = lowerBound(indices, start + base + length);
        if (first === last) return;
        if (first !== rangeEnd) {
          if (rangeStart >= 0) callback(rangeStart, rangeEnd - rangeStart);
          rangeStart = first;
        }
        rangeEnd = last;
      });
    }
    if (rangeStart >= 0) callback(rangeStart, rangeEnd - rangeStart);
  }
  /** Keep record indices and bounds on the same cut. */
  commitCut(cut) {
    // Keep index capacity within the pages charged to this input, including
    // after other inputs reuse its old slots or pages move between pools.
    this.prepareIndices(
      cut.indices.length,
      Math.ceil(cut.indices.length / RAD_PAGE_SIZE) * RAD_PAGE_SIZE,
    ).set(cut.indices);
    this.centerOnlyBounds = cut.centerOnlyBoundingBox;
    this.bounds = cut.boundingBox;
  }
  /** Internal commit of worker-prepared data; the caller gives up the arrays. */
  commitSelection(cut) {
    this.commitCut(cut);
    this.finalCut = cut.final;
  }
  /** The worker already removed outgoing records from the final cut. */
  finishFade() {
    const cut = this.finalCut;
    this.finalCut = undefined;
    if (!cut) return false;
    this.commitCut(cut);
    return true;
  }
  getByteLength() {
    return (
      super.getByteLength() +
      (this.finalCut?.indices.byteLength ?? 0) +
      (this.finalCut?.centerOnlyBoundingBox.byteLength ?? 0) +
      (this.finalCut?.boundingBox.byteLength ?? 0)
    );
  }
  dispose() {
    super.dispose();
    this.finalCut = undefined;
  }
}
