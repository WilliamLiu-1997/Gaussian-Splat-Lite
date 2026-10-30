import { IndexedSplats } from "./IndexedSplats.js";
import { RAD_PAGE_SIZE } from "./defines.js";
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
/** Shared 65,536-record RAD slots, one page per texture array layer. */
export class RadPagedSplats extends IndexedSplats {
  constructor({ pageCount, numSh }) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 256)
      throw new Error("Invalid RAD page capacity");
    super({
      capacity: pageCount * RAD_PAGE_SIZE,
      layerSize: RAD_PAGE_SIZE,
      numSh,
      blockBits: 0,
      packedOpacityGroups: true,
    });
    this.fadeProgress = 1;
    this.fadeKinds = 0;
    this.pageCount = pageCount;
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
  constructor(storage) {
    super({ storage });
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
    this.prepareIndices(cut.indices.length).set(cut.indices);
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
