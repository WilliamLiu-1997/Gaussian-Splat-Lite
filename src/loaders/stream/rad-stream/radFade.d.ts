import type { RadStreamSourceMetadata } from "./RadStreamLoader.js";
import type { RadLodSelection, RadSourceCut } from "./radLod.js";
export type RadFade = {
  indices: Uint32Array;
  fades: Uint8Array;
};
export type RadVersionedSelection = RadLodSelection & {
  selectionId: number;
};
export type RadStreamSourceCut = RadSourceCut & { fade?: RadFade };
export type RadStreamSelection = RadVersionedSelection & {
  sources: RadStreamSourceCut[];
  /** Source ID / local chunk pairs whose displayed records changed. */
  changedChunks: Uint32Array;
};
/** Compare sorted cuts and build their optional fade union in one pass. Allocate
 * the union only after a difference, so unchanged decisions allocate no fade. */
export declare function prepareRadFade(
  meta: RadStreamSourceMetadata["header"]["meta"],
  previous: Uint32Array,
  next: Uint32Array,
  enableFade: boolean,
): { changedChunks: Uint32Array; fade?: RadFade };
