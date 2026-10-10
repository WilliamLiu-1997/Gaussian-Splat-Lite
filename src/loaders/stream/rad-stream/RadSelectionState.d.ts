import type { RadMeta } from "../../rad/radFormat.js";
import type { RadStreamSelection } from "./radFade.js";
import type { RadLodRequest, RadLodSelection } from "./radLod.js";
export type RadSelectionRequest = RadLodRequest & {
  /** Pin both cuts: a waiting cut may become displayed while the RPC runs. */
  previousId?: number;
  readyId?: number;
  fade?: boolean;
};
export type RadSelectionReply = RadStreamSelection & {
  retainedBytes: number;
};
/** Worker-owned cuts. Requests pin the displayed and waiting cuts; at most
 * those two plus the new result survive. Replies never transfer cached buffers. */
export declare class RadSelectionState {
  private readonly cuts;
  private nextId;
  prepare(
    meta: RadMeta,
    selected: RadLodSelection,
    { previousId, readyId, fade }: RadSelectionRequest,
  ): RadSelectionReply;
}
