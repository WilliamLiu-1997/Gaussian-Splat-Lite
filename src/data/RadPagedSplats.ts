import { IndexedSplats } from "./IndexedSplats";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH, type SplatResult } from "./defines";

export type RadPagedSplatsOptions = {
  /** Maximum records in one decoded chunk. Defaults to Spark's 65,536. */
  pageSize?: number;
  pageCount: number;
  numSh: number;
  /** Pass the device limit when known. WebGL2 guarantees at least 256. */
  maxArrayLayers?: number;
};

/** Page ranges in a sorted, file-global cut; used only by RAD streaming. */
export type RadSelectionRange = {
  start: number;
  end: number;
  slot: number;
  sourceOffset: number;
};

export type RadSelectionSnapshot = {
  pageStride: number;
  pageOccupancy: Int32Array;
  opacityBlocks: Uint32Array;
  ranges: RadSelectionRange[];
};

export type RadPreparedSelection = {
  indices: Uint32Array;
  selectedPages: Uint32Array;
  opacityBlocks: Uint32Array;
  dirtyLayers: Uint8Array;
  fadeKinds: number;
  final?: { indices: Uint32Array; selectedPages: Uint32Array };
};

const EMPTY_INDICES = new Uint32Array(0);

/** One power-of-two texture layer per page, with no shared upload layers. */
export function radPageTextureLayout({
  pageSize = 65_536,
  pageCount,
  maxArrayLayers = 256,
}: Omit<RadPagedSplatsOptions, "numSh">) {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT
  )
    throw new Error("RAD pageSize must be between 1 and 4,194,304");
  if (
    !Number.isSafeInteger(maxArrayLayers) ||
    maxArrayLayers < 1 ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > maxArrayLayers
  )
    throw new Error("RAD pageCount exceeds the texture array layer limit");
  const pageStride =
    2 ** Math.ceil(Math.log2(Math.max(SPLAT_TEX_WIDTH, pageSize)));
  const capacity = pageStride * pageCount;
  if (!Number.isSafeInteger(capacity) || capacity > 0x1_0000_0000)
    throw new Error("RAD page pool exceeds the 32-bit source index limit");
  return {
    pageSize,
    pageStride,
    pageCount,
    capacity,
    width: SPLAT_TEX_WIDTH,
    height: pageStride / SPLAT_TEX_WIDTH,
    depth: pageCount,
  };
}

/** Fixed RAD page slots; shared IndexedSplats owns rendering and CPU access. */
export class RadPagedSplats extends IndexedSplats {
  readonly pageSize: number;
  readonly pageStride: number;
  readonly pageCount: number;
  private pageOccupancy: Int32Array;
  private selectedPages: Uint32Array;
  private finalSelection?: RadPreparedSelection["final"];
  private fadeProgress = 1;
  private fadeKinds = 0;

  constructor(options: RadPagedSplatsOptions) {
    const layout = radPageTextureLayout(options);
    super({
      capacity: layout.capacity,
      layerSize: layout.pageStride,
      numSh: options.numSh,
      blockBits: 0,
    });
    this.pageSize = layout.pageSize;
    this.pageStride = layout.pageStride;
    this.pageCount = layout.pageCount;
    this.pageOccupancy = new Int32Array(this.pageCount).fill(-1);
    this.selectedPages = new Uint32Array(this.pageCount);
  }

  pageStart(slot: number) {
    this.assertLive();
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.pageCount)
      throw new Error("Invalid RAD page slot");
    return slot * this.pageStride;
  }

  /** Copies data; callers retain ownership of the packed buffers. */
  writePage(slot: number, data: SplatResult) {
    const start = this.pageStart(slot);
    if (this.pageOccupancy[slot] !== -1)
      throw new Error("RAD page slot is occupied");
    if (data.numSplats > this.pageSize)
      throw new Error("RAD chunk does not fit its page slot");
    this.writeRecords(start, data, this.pageStride);
    this.pageOccupancy[slot] = data.numSplats;
  }

  /** Remove the displayed cut when its scheduler becomes hidden. */
  clearSelection() {
    this.assertLive();
    if (!this.numSplats) return false;
    this.commitIndices(EMPTY_INDICES);
    this.selectedPages.fill(0);
    this.finalSelection = undefined;
    this.fadeKinds = 0;
    this.fadeProgress = 1;
    this.opacities.setGroupOpacity(2, 1);
    this.opacities.setGroupOpacity(3, 1);
    return true;
  }

  /** Snapshot only changed pools; never transfer live texture storage. */
  snapshotSelection(ranges: RadSelectionRange[]): RadSelectionSnapshot {
    this.assertLive();
    return {
      pageStride: this.pageStride,
      pageOccupancy: this.pageOccupancy.slice(),
      opacityBlocks: this.opacities.copyBlocks(),
      ranges,
    };
  }

  /** Internal commit of validated data; the caller gives up the prepared arrays. */
  commitSelection(prepared: RadPreparedSelection) {
    this.commitIndices(prepared.indices);
    this.selectedPages = prepared.selectedPages;
    this.finalSelection = prepared.final;
    this.fadeKinds = prepared.fadeKinds;
    this.fadeProgress = this.fadeKinds ? 0 : 1;
    this.opacities.setGroupOpacity(2, this.fadeKinds ? 0 : 1);
    this.opacities.setGroupOpacity(3, 1);
    this.opacities.commitBlocks(prepared.opacityBlocks, prepared.dirtyLayers);
  }

  /** A normal streaming fade changes only two group coefficients. */
  setFadeProgress(progress: number) {
    this.assertLive();
    if (!Number.isFinite(progress) || progress < 0 || progress > 1)
      throw new Error("RAD fade progress must be between 0 and 1");
    if (progress === this.fadeProgress) return false;
    this.fadeProgress = progress;
    if (!this.fadeKinds) return false;
    const fadeIn = this.opacities.setGroupOpacity(2, progress);
    const fadeOut = this.opacities.setGroupOpacity(3, 1 - progress);
    return (
      (!!(this.fadeKinds & 1) && fadeIn) || (!!(this.fadeKinds & 2) && fadeOut)
    );
  }

  isPageSelected(slot: number) {
    this.pageStart(slot);
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
    this.assertLive();
    if (!this.finalSelection) return this.finishFadeIn();
    this.commitIndices(this.finalSelection.indices);
    this.selectedPages = this.finalSelection.selectedPages;
    this.finishFadeIn();
    return true;
  }

  /** Selected pages must be removed from the cut before their slots are reused. */
  releasePage(slot: number) {
    this.pageStart(slot);
    if (this.selectedPages[slot] > 0)
      throw new Error("Cannot release a selected RAD page");
    this.pageOccupancy[slot] = -1;
  }

  override getByteLength() {
    return (
      super.getByteLength() +
      (this.finalSelection?.indices.byteLength ?? 0) +
      (this.finalSelection?.selectedPages.byteLength ?? 0) +
      this.pageOccupancy.byteLength +
      this.selectedPages.byteLength
    );
  }

  override dispose() {
    super.dispose();
    this.pageOccupancy = new Int32Array(0);
    this.selectedPages = new Uint32Array(0);
    this.finalSelection = undefined;
  }
}
