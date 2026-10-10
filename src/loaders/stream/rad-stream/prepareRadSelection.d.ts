import type {
  RadPreparedSelection,
  RadSelectionSnapshot,
} from "../../../data/RadPagedSplats.js";
import type { RadStreamSelection } from "./radFade.js";
import type { RadLodChunk } from "./radLod.js";
export type RadSelectionChunk = Pick<
  RadLodChunk,
  "sourceToStorage" | "boundsBlocks"
>;
/** The scheduler snapshots and pins resident pages before dispatching this work. */
export declare function prepareRadSelection(
  {
    selection,
    pools,
  }: {
    selection: RadStreamSelection;
    pools: RadSelectionSnapshot[];
  },
  chunks: ReadonlyMap<number, RadSelectionChunk>,
): {
  selection: {
    indices: Uint32Array;
    wantedChunks: Uint32Array;
    touchedChunks: Uint32Array;
    selectionId: number;
    changedChunks: Uint32Array;
  };
  fade: boolean;
  pools: RadPreparedSelection[];
};
export type RadSelectionPreparation = ReturnType<typeof prepareRadSelection>;
