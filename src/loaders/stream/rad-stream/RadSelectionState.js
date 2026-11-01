import { prepareRadFade } from "./radFade.js";
const EMPTY_INDICES = new Uint32Array(0);
/** Worker-owned cuts. Requests pin the baseline, displayed and waiting cuts;
 * at most those three plus the new result survive. Replies copy cached buffers. */
export class RadSelectionState {
  constructor() {
    this.cuts = new Map();
    this.nextId = 1;
  }
  /** Copy local file indices for relocation without changing the selection ID. */
  snapshot(id) {
    const cut = this.cuts.get(id);
    if (!cut) throw new Error("RAD: displayed selection is unavailable");
    return Array.from(cut, ([source, indices]) => ({
      source,
      indices: indices.slice(),
    }));
  }
  /** Remove only this source; surviving cuts keep their local addresses. */
  removeSource(source) {
    for (const cut of this.cuts.values()) cut.delete(source);
  }
  get byteLength() {
    let bytes = 0;
    for (const cut of this.cuts.values())
      for (const indices of cut.values()) bytes += indices.byteLength;
    return bytes;
  }
  prepare(
    metaBySource,
    selected,
    { previousId = 0, displayedId = 0, readyId = 0, fade = false },
  ) {
    const previous = previousId ? this.cuts.get(previousId) : new Map();
    if (
      !previous ||
      (displayedId && !this.cuts.has(displayedId)) ||
      (readyId && !this.cuts.has(readyId))
    )
      throw new Error("RAD: selection baseline is unavailable");
    // The baseline may still be preparing. Keep the displayed cut for cancellation
    // and the waiting cut for publication while traversal is in flight.
    for (const id of this.cuts.keys()) {
      if (id !== previousId && id !== displayedId && id !== readyId)
        this.cuts.delete(id);
    }
    const changed = [];
    const sources = selected.sources.map(({ source, indices }) => {
      const transition = prepareRadFade(
        metaBySource.get(source),
        previous.get(source) ?? EMPTY_INDICES,
        indices,
        fade,
      );
      for (const chunk of transition.changedChunks) changed.push(source, chunk);
      return { source, indices, fade: transition.fade };
    });
    let selectionId = previousId;
    if (changed.length) {
      selectionId = this.nextId++;
      this.cuts.set(
        selectionId,
        new Map(sources.map(({ source, indices }) => [source, indices])),
      );
      // Preserve cached cuts when transferring the complete result.
      for (const source of sources) source.indices = source.indices.slice();
    }
    return {
      ...selected,
      selectionId,
      sources,
      changedChunks: Uint32Array.from(changed),
      retainedBytes: this.byteLength,
    };
  }
}
