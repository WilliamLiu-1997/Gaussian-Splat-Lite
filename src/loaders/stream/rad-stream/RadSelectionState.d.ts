import type { RadStreamSourceMetadata } from "./RadStreamLoader.js";
import type { RadStreamSelection } from "./radFade.js";
import type { RadLodRequest, RadLodSelection, RadSourceCut } from "./radLod.js";
export type RadSelectionRequest = RadLodRequest & {
  /** Fade baseline: the preparing cut, or the displayed cut when none is pending. */
  previousId?: number;
  /** Retain the displayed cut if preparation is cancelled. */
  displayedId?: number;
  /** Retain a waiting cut that may start preparation while traversal runs. */
  readyId?: number;
  fade?: boolean;
};
export type RadSelectionReply = RadStreamSelection & {
  retainedBytes: number;
};
/** Worker-owned cuts. Requests pin the baseline, displayed and waiting cuts;
 * at most those three plus the new result survive. Replies copy cached buffers. */
export declare class RadSelectionState {
  private readonly cuts;
  private nextId;
  /** Copy the displayed cut for a physical relocation without changing its ID. */
  snapshot(id: number): RadSourceCut[];
  removeSource(source: number): void;
  get byteLength(): number;
  prepare(
    metaBySource: ReadonlyMap<
      number,
      RadStreamSourceMetadata["header"]["meta"]
    >,
    selected: RadLodSelection,
    { previousId, displayedId, readyId, fade }: RadSelectionRequest,
  ): RadSelectionReply;
}
