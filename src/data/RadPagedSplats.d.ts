import { IndexedSplats } from "./IndexedSplats.js";
import type { ReorderedSplatResult } from "./defines.js";
import type { RaycastRangeCallback, SplatRaycastQuery } from "./raycast.js";
export type RadPagedSplatsOptions = {
  pageCount: number;
  numSh: number;
};
/** Page ranges in a sorted, file-global cut; used only by RAD streaming. */
export type RadSelectionRange = {
  start: number;
  end: number;
  slot: number;
  chunkIndex: number;
  sourceBase: number;
  /** Input whose view draws this page. */
  input: number;
};
export type RadSelectionSnapshot = {
  pageCount: number;
  /** Sixteen two-bit RAD group IDs per word, in source storage order. */
  opacityBlocks: Uint32Array;
  ranges: RadSelectionRange[];
};
type RadPreparedCut = {
  indices: Uint32Array;
  centerOnlyBoundingBox: Float32Array;
  boundingBox: Float32Array;
};
/** One input's records across the pool, plus its post-fade cut when pages fade out. */
export type RadPreparedViewCut = RadPreparedCut & {
  input: number;
  final?: RadPreparedCut;
};
export type RadPreparedSelection = {
  cuts: RadPreparedViewCut[];
  selectedPages: Uint32Array;
  finalSelectedPages?: Uint32Array;
  opacityBlocks: Uint32Array;
  dirtyLayers: Uint8Array;
  fadeKinds: number;
};
/** Shared 65,536-record RAD slots, one page per texture array layer. */
export declare class RadPagedSplats extends IndexedSplats {
  readonly pageCount: number;
  private selectedPages;
  private finalSelectedPages?;
  private fadeProgress;
  private fadeKinds;
  constructor(options: RadPagedSplatsOptions);
  /** Copies data and zeros SH above numSh; callers retain the packed buffers. */
  writePage(slot: number, data: ReorderedSplatResult, numSh?: number): void;
  releasePage(slot: number): void;
  /** Remove the displayed cut when its scheduler becomes hidden. */
  clearSelection(): void;
  /** Never transfer live texture storage to the preparation worker. */
  snapshotSelection(ranges: RadSelectionRange[]): RadSelectionSnapshot;
  /** Internal commit of worker-prepared data; views commit each input's cut. */
  commitSelection(prepared: RadPreparedSelection): void;
  /** A normal streaming fade changes only two group coefficients. */
  setFadeProgress(progress: number): boolean;
  isPageSelected(slot: number): boolean;
  /** Complete opacity changes; views remove outgoing records themselves. */
  finishFade(): boolean;
  getByteLength(): number;
  dispose(): void;
}
/**
 * One input's selected records across the shared page pool. Cuts list records
 * in ascending storage order, so picking needs no pool-sized reverse map.
 */
export declare class RadPageView extends IndexedSplats {
  private finalCut?;
  constructor(storage: RadPagedSplats);
  forEachRaycastRange(
    query: SplatRaycastQuery,
    callback: RaycastRangeCallback,
  ): void;
  /** Keep record indices and bounds on the same cut. */
  private commitCut;
  /** Internal commit of worker-prepared data; the caller gives up the arrays. */
  commitSelection(cut: RadPreparedViewCut): void;
  /** The worker already removed outgoing records from the final cut. */
  finishFade(): boolean;
  getByteLength(): number;
  dispose(): void;
}
export {};
