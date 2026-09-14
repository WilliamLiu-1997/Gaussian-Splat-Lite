import { IndexedSplats } from "./IndexedSplats";
import {
  type ReorderedSplatResult,
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines";
import { resetSplatBounds } from "./splatData";

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
  pageStart: number;
  chunkIndex: number;
  sourceBase: number;
};

export type RadSelectionSnapshot = {
  pageCount: number;
  opacityBlocks: Uint32Array;
  ranges: RadSelectionRange[];
};

type RadPreparedCut = {
  indices: Uint32Array;
  selectedPages: Uint32Array;
  centerOnlyBoundingBox: Float32Array;
  boundingBox: Float32Array;
};

export type RadPreparedSelection = RadPreparedCut & {
  opacityBlocks: Uint32Array;
  dirtyLayers: Uint8Array;
  fadeKinds: number;
  final?: RadPreparedCut;
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
  if (capacity > 0x1_0000_0000)
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
  private selectedPages: Uint32Array;
  private finalSelection?: RadPreparedCut;
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
    this.selectedPages = new Uint32Array(this.pageCount);
  }

  pageStart(slot: number) {
    return slot * this.pageStride;
  }

  /** Copies data; callers retain ownership of the packed buffers. */
  writePage(slot: number, data: ReorderedSplatResult) {
    const start = this.pageStart(slot);
    if (data.numSplats > this.pageSize)
      throw new Error("RAD chunk does not fit its page slot");
    this.writeRecords(start, data, this.pageStride);
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
  snapshotSelection(ranges: RadSelectionRange[]): RadSelectionSnapshot {
    this.assertLive();
    return {
      pageCount: this.pageCount,
      opacityBlocks: this.opacities.copyBlocks(),
      ranges,
    };
  }

  /** Internal commit of worker-prepared data; the caller gives up the arrays. */
  commitSelection(prepared: RadPreparedSelection) {
    this.commitCut(prepared);
    this.finalSelection = prepared.final;
    this.fadeKinds = prepared.fadeKinds;
    this.fadeProgress = this.fadeKinds ? 0 : 1;
    this.opacities.setGroupOpacity(2, this.fadeKinds ? 0 : 1);
    this.opacities.setGroupOpacity(3, 1);
    this.opacities.commitBlocks(prepared.opacityBlocks, prepared.dirtyLayers);
  }

  /** Keep record indices, page occupancy and bounds on the same cut. */
  private commitCut(cut: RadPreparedCut) {
    this.commitIndices(cut.indices);
    this.selectedPages = cut.selectedPages;
    this.centerOnlyBounds = cut.centerOnlyBoundingBox;
    this.bounds = cut.boundingBox;
  }

  /** A normal streaming fade changes only two group coefficients. */
  setFadeProgress(progress: number) {
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

  isPageSelected(slot: number) {
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

  override getByteLength() {
    return (
      super.getByteLength() +
      (this.finalSelection?.indices.byteLength ?? 0) +
      (this.finalSelection?.selectedPages.byteLength ?? 0) +
      (this.finalSelection?.centerOnlyBoundingBox.byteLength ?? 0) +
      (this.finalSelection?.boundingBox.byteLength ?? 0) +
      this.selectedPages.byteLength
    );
  }

  override dispose() {
    super.dispose();
    this.selectedPages = new Uint32Array(0);
    this.finalSelection = undefined;
  }
}
