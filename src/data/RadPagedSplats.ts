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

export type RadPreparedSelection = {
  indices: Uint32Array;
  fades?: Uint8Array;
  selectedPages: Uint32Array;
  fadeKinds: number;
};

const NO_FADES = new Uint8Array(0);

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
  private selectedFades: Uint8Array = NO_FADES;
  private fadeProgress = 1;
  private fadeKinds = 0;
  private sharedFadeGroups = true;

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

  /**
   * Physical indices select only populated records. Copies the caller's map,
   * preventing worker transfers or caller mutation from changing a live cut.
   */
  setSelection(indices: Uint32Array, fades?: Uint8Array) {
    this.assertLive();
    if (indices.length > this.maxSplats)
      throw new Error("RAD selection exceeds page pool capacity");
    if (fades && fades.length !== indices.length)
      throw new Error("RAD fade map must match the selection length");
    // Most pools do not change when a page finishes loading. Compare their
    // compact maps before validation, page counting and opacity initialization.
    if (indices.length === this.numSplats) {
      let same = true;
      for (let index = 0; index < indices.length; index++) {
        if (
          this.sourceIndices[index] !== indices[index] ||
          (this.selectedFades[index] ?? 0) !== (fades?.[index] ?? 0)
        ) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    const selectedPages = new Uint32Array(this.pageCount);
    let fadeKinds = 0;
    for (let index = 0; index < indices.length; index++) {
      const source = indices[index];
      const slot = Math.floor(source / this.pageStride);
      if (
        slot >= this.pageCount ||
        source - slot * this.pageStride >= this.pageOccupancy[slot]
      )
        throw new Error(
          "RAD selection references an unloaded page or page padding",
        );
      selectedPages[slot]++;
      const fade = fades?.[index] ?? 0;
      if (fade > 2) throw new Error("Invalid RAD index fade kind");
      fadeKinds |= fade;
    }
    // Public callers may repeat a record with conflicting fade kinds. Preserve
    // their sequential opacity writes; streaming cuts always contain unique IDs.
    const sharedFadeGroups =
      !fadeKinds || new Set(indices).size === indices.length;
    this.commitSelection(
      {
        indices,
        fades: fadeKinds ? fades?.slice() : undefined,
        selectedPages,
        fadeKinds,
      },
      sharedFadeGroups,
    );
    return true;
  }

  /** Prepare owned per-pool data without modifying the displayed selection. */
  prepareSelection(
    indices: Uint32Array,
    fades: Uint8Array | undefined,
    ranges: readonly RadSelectionRange[],
  ): RadPreparedSelection {
    this.assertLive();
    if (fades && fades.length !== indices.length)
      throw new Error("RAD fade map must match the selection length");
    let count = 0;
    for (const range of ranges) {
      this.pageStart(range.slot);
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        !Number.isSafeInteger(range.sourceOffset) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > indices.length
      )
        throw new Error("Invalid RAD selection range");
      count += range.end - range.start;
    }
    if (count > this.maxSplats)
      throw new Error("RAD selection exceeds page pool capacity");
    const target = new Uint32Array(count);
    const targetFades = fades ? new Uint8Array(count) : undefined;
    const selectedPages = new Uint32Array(this.pageCount);
    let offset = 0;
    let fadeKinds = 0;
    for (const { start, end, slot, sourceOffset } of ranges) {
      const first = slot * this.pageStride;
      const last = first + this.pageOccupancy[slot];
      selectedPages[slot] += end - start;
      for (let index = start; index < end; index++) {
        const source = indices[index] + sourceOffset;
        const fade = fades?.[index] ?? 0;
        if (source < first || source >= last)
          throw new Error(
            "RAD selection references an unloaded page or page padding",
          );
        if (fade > 2) throw new Error("Invalid RAD index fade kind");
        target[offset] = source;
        if (targetFades) targetFades[offset] = fade;
        fadeKinds |= fade;
        offset++;
      }
    }
    return {
      indices: target,
      fades: fadeKinds ? targetFades : undefined,
      selectedPages,
      fadeKinds,
    };
  }

  /** Internal commit of validated data; the caller gives up the prepared arrays. */
  commitSelection(prepared: RadPreparedSelection, sharedFadeGroups = true) {
    this.commitIndices(prepared.indices);
    this.selectedPages = prepared.selectedPages;
    this.selectedFades = prepared.fades ?? NO_FADES;
    this.fadeKinds = prepared.fadeKinds;
    this.sharedFadeGroups = sharedFadeGroups;
    this.fadeProgress = this.fadeKinds ? 0 : 1;
    this.opacities.setGroupOpacity(2, this.fadeKinds ? 0 : 1);
    this.opacities.setGroupOpacity(3, 1);
    if (sharedFadeGroups) {
      this.opacities.setIndexed(prepared.indices, prepared.fades);
    } else {
      for (let index = 0; index < prepared.indices.length; index++)
        this.opacities.setOpacity(
          prepared.indices[index],
          1,
          prepared.fades?.[index] === 1 ? 0 : 1,
        );
    }
  }

  /** A normal streaming fade changes only two group coefficients. */
  setFadeProgress(progress: number) {
    this.assertLive();
    if (!Number.isFinite(progress) || progress < 0 || progress > 1)
      throw new Error("RAD fade progress must be between 0 and 1");
    if (progress === this.fadeProgress) return false;
    this.fadeProgress = progress;
    if (!this.selectedFades.length) return false;
    if (this.sharedFadeGroups) {
      const fadeIn = this.opacities.setGroupOpacity(2, progress);
      const fadeOut = this.opacities.setGroupOpacity(3, 1 - progress);
      return (
        (!!(this.fadeKinds & 1) && fadeIn) ||
        (!!(this.fadeKinds & 2) && fadeOut)
      );
    }
    let changed = false;
    for (let index = 0; index < this.numSplats; index++) {
      const fade = this.selectedFades[index];
      if (!fade) continue;
      changed =
        this.opacities.setOpacity(
          this.sourceIndices[index],
          1,
          fade === 1 ? progress : 1 - progress,
        ) || changed;
    }
    return changed;
  }

  isPageSelected(slot: number) {
    this.pageStart(slot);
    return this.selectedPages[slot] > 0;
  }

  /** Complete opacity changes without removing outgoing records. */
  finishFadeIn() {
    const changed = this.setFadeProgress(1);
    this.selectedFades = NO_FADES;
    this.fadeKinds = 0;
    return changed;
  }

  /** Keep final records in their existing order without remapping the global cut. */
  finishFade() {
    this.assertLive();
    if (!(this.fadeKinds & 2)) return this.finishFadeIn();
    let count = 0;
    for (let index = 0; index < this.numSplats; index++) {
      const source = this.sourceIndices[index];
      if (this.selectedFades[index] === 2) {
        this.selectedPages[Math.floor(source / this.pageStride)]--;
      } else this.sourceIndices[count++] = source;
    }
    const indices = this.sourceIndices.subarray(0, count);
    if (!this.sharedFadeGroups) {
      this.setSelection(indices);
    } else {
      this.commitIndices(indices);
      this.finishFadeIn();
    }
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
      this.selectedFades.byteLength +
      this.pageOccupancy.byteLength +
      this.selectedPages.byteLength
    );
  }

  override dispose() {
    super.dispose();
    this.pageOccupancy = new Int32Array(0);
    this.selectedPages = new Uint32Array(0);
    this.selectedFades = NO_FADES;
  }
}
