import { IndexedSplats } from "./IndexedSplats.js";
import type { ReorderedSplatResult } from "./defines.js";
export type RadPagedSplatsOptions = {
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
  chunkIndex: number;
  sourceBase: number;
};
export type RadSelectionSnapshot = {
  pageCount: number;
  /** Sixteen two-bit RAD group IDs per word, in source storage order. */
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
/** Fixed 65,536-record RAD slots, each occupying one texture array layer. */
export declare class RadPagedSplats extends IndexedSplats {
  readonly pageCount: number;
  private selectedPages;
  private finalSelection?;
  private fadeProgress;
  private fadeKinds;
  constructor(options: RadPagedSplatsOptions);
  /** Copies data and zeros SH above numSh; callers retain the packed buffers. */
  writePage(slot: number, data: ReorderedSplatResult, numSh?: number): void;
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
