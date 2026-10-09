import { IndexedSplats } from "./IndexedSplats.js";
import type { ReorderedSplatResult } from "./defines.js";
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
/** One power-of-two texture layer per page, with no shared upload layers. */
export declare function radPageTextureLayout({
  pageSize,
  pageCount,
  maxArrayLayers,
}: Omit<RadPagedSplatsOptions, "numSh">): {
  pageSize: number;
  pageStride: number;
  pageCount: number;
  capacity: number;
  width: number;
  height: number;
  depth: number;
};
/** Fixed RAD page slots; shared IndexedSplats owns rendering and CPU access. */
export declare class RadPagedSplats extends IndexedSplats {
  readonly pageSize: number;
  readonly pageStride: number;
  readonly pageCount: number;
  private selectedPages;
  private finalSelection?;
  private fadeProgress;
  private fadeKinds;
  constructor(options: RadPagedSplatsOptions);
  pageStart(slot: number): number;
  /** Copies data; callers retain ownership of the packed buffers. */
  writePage(slot: number, data: ReorderedSplatResult): void;
  /** Remove the displayed cut when its scheduler becomes hidden. */
  clearSelection(): boolean;
  /** Snapshot only changed pools; never transfer live texture storage. */
  snapshotSelection(ranges: RadSelectionRange[]): RadSelectionSnapshot;
  /** Internal commit of worker-prepared data; the caller gives up the arrays. */
  commitSelection(prepared: RadPreparedSelection): void;
  /** Keep record indices, page occupancy and bounds on the same cut. */
  private commitCut;
  /** A normal streaming fade changes only two group coefficients. */
  setFadeProgress(progress: number): boolean;
  isPageSelected(slot: number): boolean;
  /** Complete opacity changes without removing outgoing records. */
  finishFadeIn(): boolean;
  /** The worker already removed outgoing records from the final cut. */
  finishFade(): boolean;
  getByteLength(): number;
  dispose(): void;
}
export {};
