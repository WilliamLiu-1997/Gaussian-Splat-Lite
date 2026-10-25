import { IndexedSplats } from "./IndexedSplats.js";
import { RAD_PAGE_SIZE } from "./defines.js";
import { resetSplatBounds } from "./splatData.js";
const EMPTY_INDICES = new Uint32Array(0);
/** Fixed 65,536-record RAD slots, each occupying one texture array layer. */
export class RadPagedSplats extends IndexedSplats {
  constructor({ pageCount, numSh, maxArrayLayers = 256 }) {
    if (
      !Number.isSafeInteger(maxArrayLayers) ||
      maxArrayLayers < 1 ||
      !Number.isSafeInteger(pageCount) ||
      pageCount < 1 ||
      pageCount > maxArrayLayers
    )
      throw new Error("RAD pageCount exceeds the texture array layer limit");
    super({
      capacity: RAD_PAGE_SIZE * pageCount,
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
  /** Copies data; callers retain ownership of the packed buffers. */
  writePage(slot, data) {
    this.writeRecords(slot * RAD_PAGE_SIZE, data, RAD_PAGE_SIZE);
  }
  /** Remove the displayed cut when its scheduler becomes hidden. */
  clearSelection() {
    this.assertLive();
    if (!this.numSplats) return false;
    this.commitIndices(EMPTY_INDICES);
    this.selectedPages.fill(0);
    resetSplatBounds(this.centerOnlyBounds);
    resetSplatBounds(this.bounds);
    this.finalSelection = undefined;
    this.fadeKinds = 0;
    this.fadeProgress = 1;
    this.opacities.setGroupOpacity(2, 1);
    this.opacities.setGroupOpacity(3, 1);
    return true;
  }
  /** Snapshot only changed pools; never transfer live texture storage. */
  snapshotSelection(ranges) {
    this.assertLive();
    return {
      pageCount: this.pageCount,
      opacityBlocks: this.opacities.copyBlocks(),
      ranges,
    };
  }
  /** Internal commit of worker-prepared data; the caller gives up the arrays. */
  commitSelection(prepared) {
    this.commitCut(prepared);
    this.finalSelection = prepared.final;
    this.fadeKinds = prepared.fadeKinds;
    this.fadeProgress = this.fadeKinds ? 0 : 1;
    this.opacities.setGroupOpacity(2, this.fadeKinds ? 0 : 1);
    this.opacities.setGroupOpacity(3, 1);
    this.opacities.commitBlocks(prepared.opacityBlocks, prepared.dirtyLayers);
  }
  /** Keep record indices, page occupancy and bounds on the same cut. */
  commitCut(cut) {
    this.commitIndices(cut.indices);
    this.selectedPages = cut.selectedPages;
    this.centerOnlyBounds = cut.centerOnlyBoundingBox;
    this.bounds = cut.boundingBox;
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
  /** Complete opacity changes without removing outgoing records. */
  finishFadeIn() {
    const changed = this.setFadeProgress(1);
    this.finalSelection = undefined;
    this.fadeKinds = 0;
    return changed;
  }
  /** The worker already removed outgoing records from the final cut. */
  finishFade() {
    if (!this.finalSelection) return this.finishFadeIn();
    this.commitCut(this.finalSelection);
    this.finishFadeIn();
    return true;
  }
  getByteLength() {
    return (
      super.getByteLength() +
      (this.finalSelection?.indices.byteLength ?? 0) +
      (this.finalSelection?.selectedPages.byteLength ?? 0) +
      (this.finalSelection?.centerOnlyBoundingBox.byteLength ?? 0) +
      (this.finalSelection?.boundingBox.byteLength ?? 0) +
      this.selectedPages.byteLength
    );
  }
  dispose() {
    super.dispose();
    this.selectedPages = new Uint32Array(0);
    this.finalSelection = undefined;
  }
}
