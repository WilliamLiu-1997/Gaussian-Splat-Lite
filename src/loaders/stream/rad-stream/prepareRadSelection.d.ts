import type {
  RadPreparedSelection,
  RadSelectionSnapshot,
} from "../../../data/RadPagedSplats.js";
import type { RadStreamSelection, RadStreamSourceCut } from "./radFade.js";
import type { RadLodChunk, RadSourceCut } from "./radLod.js";
export type RadSelectionChunk = Pick<
  RadLodChunk,
  "sourceToStorage" | "boundsBlocks"
>;
export type RadSelectionPreparation = {
  selection: RadStreamSelection;
  fade: boolean;
  pools: RadPreparedSelection[];
};
/** Index and fade arrays of cuts sent for preparation. */
export declare function selectionIndexBytes(
  sources?: readonly RadStreamSourceCut[],
): number;
/** Temporary bytes of preparing these cuts for pool snapshots, per cut kept. */
export declare function preparationRequestBytes(
  sources: readonly RadStreamSourceCut[],
  pools: readonly RadSelectionSnapshot[],
  cutsPerInput: number,
): number;
/** The scheduler snapshots and pins resident pages before dispatching this work. */
export declare function prepareRadSelection(
  request: {
    selection: RadStreamSelection;
    pools: RadSelectionSnapshot[];
  },
  chunks: ReadonlyMap<number, ReadonlyMap<number, RadSelectionChunk>>,
): RadSelectionPreparation;
/** Rebuild affected views after relocating a settled cut between pools. */
export declare function prepareRadMerge(
  request: { sources: RadSourceCut[]; pools: RadSelectionSnapshot[] },
  chunks: ReadonlyMap<number, ReadonlyMap<number, RadSelectionChunk>>,
): RadPreparedSelection[];
