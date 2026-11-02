import { ChunkStreamScheduler } from "../chunk-stream/ChunkStreamScheduler.js";

/** Streams LCC2 splat files while retaining complete parent/child coverage. */
export class Lcc2StreamScheduler extends ChunkStreamScheduler {
  constructor(options = {}) {
    super(
      { ...options, lodDistanceShrink: options.lodDistanceShrink ?? 0 },
      "lcc2",
    );
    this.drawn = new Set();
  }
  isRangeVisible(range) {
    return this.drawn.has(range.leaf);
  }
  dispose() {
    super.dispose();
    this.drawn.clear();
  }
  selectRegions() {
    for (const leaf of this.leaves.values()) leaf.target = undefined;
    this.wanted.clear();
    const selected = new Set();
    const drawn = new Set();
    const cuts = new Map();
    const priority = new Map();
    for (let i = 0; this.shown && i < this.selection.length; i += 3) {
      const source = this.selection[i];
      const id = this.selection[i + 1];
      if (!cuts.has(source)) cuts.set(source, new Set());
      cuts.get(source).add(id);
      priority.set(id, i);
    }
    const need = (range) => {
      if (!range.count) return;
      const leaf = this.leafState(range.leaf);
      leaf.target = range;
      selected.add(leaf);
      if (leaf.current?.range !== range)
        this.wanted.add(this.chunks.get(range.file));
    };
    for (const [source, cut] of cuts) {
      const { metadata } = this.sources.get(source);
      const { parents, childOffsets, children, leafBase, emptyCoverage } =
        metadata;
      const end = leafBase + parents.length;
      const resident = new Set();
      for (const [id, leaf] of this.leaves) {
        if (!leaf.current || id < leafBase || id >= end) continue;
        for (let n = id - leafBase; n >= 0 && !resident.has(n); n = parents[n])
          resident.add(n);
      }
      const refined = new Set();
      // Selection is distance-ordered; each ancestor inherits its nearest target.
      for (const id of cut)
        for (
          let p = parents[id - leafBase];
          p >= 0 && !refined.has(p);
          p = parents[p]
        ) {
          refined.add(p);
          priority.set(leafBase + p, priority.get(id));
        }
      const rangeOf = (n) => this.rangeLeaf(source, leafBase + n).lods[0];
      const ready = (range) =>
        !range.count || this.leaves.get(range.leaf)?.current?.range === range;
      const own = (range) => ({
        complete: true,
        nodes: range.count ? [range.leaf] : [],
      });
      const below = (n, visit) => {
        const result = {
          complete: childOffsets[n] < childOffsets[n + 1],
          nodes: [],
        };
        for (let i = childOffsets[n]; i < childOffsets[n + 1]; i++) {
          const child = visit(children[i]);
          result.complete &&= child.complete;
          result.nodes.push(...child.nodes);
        }
        return result;
      };
      // Zooming out can keep a complete finer cut while the new node loads.
      const fallback = (n) => {
        if (!resident.has(n))
          return { complete: !!emptyCoverage[n], nodes: [] };
        const range = rangeOf(n);
        return ready(range) ? own(range) : below(n, fallback);
      };
      const visit = (n) => {
        const range = rangeOf(n);
        if (!refined.has(n)) {
          need(range);
          return ready(range) ? own(range) : fallback(n);
        }
        const result = below(n, visit);
        if (result.complete) return result;
        need(range);
        return ready(range) ? own(range) : result;
      };
      const next = [];
      for (const n of metadata.roots) next.push(...visit(n).nodes);
      // Finish one coverage transition before beginning the next one.
      const fading = [...this.fades.keys()].some(
        ({ range }) => range.leaf >= leafBase && range.leaf < end,
      );
      const visible = fading
        ? [...this.drawn].filter((id) => id >= leafBase && id < end)
        : next;
      for (const id of visible) {
        drawn.add(id);
        need(rangeOf(id - leafBase));
      }
    }
    if (this.shown)
      for (const chunk of this.environments) {
        const range = chunk.environmentRange;
        if (range) {
          need(range);
          drawn.add(range.leaf);
        } else if (chunk.count !== 0) this.wanted.add(chunk);
      }
    this.drawn = drawn;
    for (const leaf of this.leaves.values())
      if (leaf.pending?.data && leaf.target !== leaf.pending.range)
        leaf.pending = undefined;
    // Coarse coverage gets the first download/upload slots.
    const ordered = [...selected].sort(
      (a, b) =>
        b.target.level - a.target.level ||
        (priority.get(a.target.leaf) ?? this.selection.length) -
          (priority.get(b.target.leaf) ?? this.selection.length),
    );
    const wanted = new Set(this.wanted);
    this.wanted.clear();
    for (const leaf of ordered) {
      const chunk = this.chunks.get(leaf.target.file);
      if (wanted.has(chunk)) this.wanted.add(chunk);
    }
    for (const chunk of wanted) this.wanted.add(chunk);
    if (this.shown && cuts.size && !ordered.length && !this.wanted.size)
      this.resolveFirst(this);
    return { selected: ordered, refinements: [] };
  }
}
