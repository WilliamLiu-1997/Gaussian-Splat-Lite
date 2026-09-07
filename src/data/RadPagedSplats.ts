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
  private selectedFades = new Uint8Array(0);
  private fadeProgress = 1;

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
    let hasFades = false;
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
      hasFades ||= fade !== 0;
    }
    this.commitIndices(indices);
    this.selectedFades = hasFades
      ? (fades as Uint8Array).slice()
      : new Uint8Array(0);
    this.fadeProgress = hasFades ? 0 : 1;
    for (let index = 0; index < indices.length; index++)
      this.opacities.setOpacity(
        indices[index],
        1,
        fades?.[index] === 1 ? 0 : 1,
      );
    this.selectedPages = selectedPages;
    return true;
  }

  /** Update only opacity layers during a fade, retaining source/index textures
   * and sort data until outgoing records are removed. */
  setFadeProgress(progress: number) {
    this.assertLive();
    if (!Number.isFinite(progress) || progress < 0 || progress > 1)
      throw new Error("RAD fade progress must be between 0 and 1");
    if (progress === this.fadeProgress) return false;
    this.fadeProgress = progress;
    if (!this.selectedFades.length) return false;
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

  /** The scheduler uses this only when no outgoing records need removal. */
  finishFadeIn() {
    const changed = this.setFadeProgress(1);
    this.selectedFades = new Uint8Array(0);
    return changed;
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
    this.selectedFades = new Uint8Array(0);
  }
}
