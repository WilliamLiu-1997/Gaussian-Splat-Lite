import type { RadMeta } from "../../rad/radFormat.js";
import type { RadLodSelection } from "./radLod.js";
export type RadFade = {
  indices: Uint32Array;
  fades: Uint8Array;
};
export type RadVersionedSelection = RadLodSelection & {
  selectionId: number;
};
export type RadStreamSelection = RadVersionedSelection & {
  changedChunks: Uint32Array;
  fade?: RadFade;
};
/** Compare sorted cuts and build their optional fade union in one pass. Allocate
 * the union only after a difference, so unchanged decisions allocate no fade. */
export declare function prepareRadFade(
  meta: RadMeta,
  previous: Uint32Array,
  next: Uint32Array,
  enableFade: boolean,
): Pick<RadStreamSelection, "changedChunks" | "fade">;
