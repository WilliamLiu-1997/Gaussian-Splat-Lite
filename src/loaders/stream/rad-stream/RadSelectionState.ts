import type { RadMeta } from "../../rad/radFormat";
import { type RadStreamSelection, prepareRadFade } from "./radFade";
import type { RadLodRequest, RadLodSelection } from "./radLod";

export type RadSelectionRequest = RadLodRequest & {
  /** Pin both cuts: a waiting cut may become displayed while the RPC runs. */
  previousId?: number;
  readyId?: number;
  fade?: boolean;
};

export type RadSelectionReply = RadStreamSelection & {
  retainedBytes: number;
};

const EMPTY_INDICES = new Uint32Array(0);

/** Worker-owned cuts. Requests pin the displayed and waiting cuts; at most
 * those two plus the new result survive. Replies never transfer cached buffers. */
export class RadSelectionState {
  private readonly cuts = new Map<number, Uint32Array>();
  private nextId = 1;

  prepare(
    meta: RadMeta,
    selected: RadLodSelection,
    { previousId = 0, readyId = 0, fade = false }: RadSelectionRequest,
  ): RadSelectionReply {
    const previous = previousId ? this.cuts.get(previousId) : EMPTY_INDICES;
    if (!previous || (readyId && !this.cuts.has(readyId)))
      throw new Error("RAD: selection baseline is unavailable");
    for (const id of this.cuts.keys()) {
      if (id !== previousId && id !== readyId) this.cuts.delete(id);
    }
    const transition = prepareRadFade(meta, previous, selected.indices, fade);
    let selectionId = previousId;
    let indices = selected.indices;
    if (transition.changedChunks.length) {
      selectionId = this.nextId++;
      this.cuts.set(selectionId, selected.indices);
      // Preserve the cached cut when transferring the complete result.
      indices = selected.indices.slice();
    }
    let retainedBytes = 0;
    for (const cut of this.cuts.values()) retainedBytes += cut.byteLength;
    return {
      ...selected,
      selectionId,
      indices,
      ...transition,
      retainedBytes,
    };
  }
}
