import { ChunkStreamScheduler } from "../chunk-stream/ChunkStreamScheduler.js";
import { resolveSogLod } from "./sogLod.js";
/** Camera-driven Streamed SOG loading with per-chunk sources and region fades. */
export class SogStreamScheduler extends ChunkStreamScheduler {
  constructor(options = {}) {
    super(options, "sog");
  }
  selectRegions() {
    for (const leaf of this.leaves.values()) leaf.target = undefined;
    const selected = [];
    this.wanted.clear();
    const show = (range) => {
      const leaf = this.leafState(range.leaf);
      leaf.target = range;
      selected.push(leaf);
      if (leaf.current?.range !== range)
        this.wanted.add(this.chunks.get(range.file));
    };
    if (this.shown)
      for (const chunk of this.environments) {
        const current = this.leaves.get(-1 - chunk.index)?.current;
        const range = current?.range ?? chunk.environmentRange;
        if (range && (current || chunk.data?.alive)) show(range);
        else if (chunk.count !== 0) this.wanted.add(chunk);
      }
    const refinements = [];
    for (
      let offset = 0;
      this.shown && offset < this.selection.length;
      offset += 3
    ) {
      const sourceId = this.selection[offset];
      const id = this.selection[offset + 1];
      const leaf = this.rangeLeaf(sourceId, id);
      const target = leaf.lods[this.selection[offset + 2]];
      const state = this.leafState(leaf.id);
      const { range, load, refinement } = resolveSogLod(
        leaf,
        target,
        state.current?.range,
        (lod) => this.chunks.get(lod.file).data?.alive === true,
      );
      if (range) show(range);
      if (load) {
        const chunk = this.chunks.get(load.file);
        if (range && refinement) refinements.push([state, chunk]);
        else this.wanted.add(chunk);
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.pending?.data && leaf.target !== leaf.pending.range)
        leaf.pending = undefined;
    }
    return { selected, refinements };
  }
}
