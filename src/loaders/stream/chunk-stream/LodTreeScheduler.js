import { ChunkStreamScheduler } from "./ChunkStreamScheduler.js";

const LOAD_PREFETCH = 0;
const LOAD_SWITCH = 1;
const LOAD_VISIBLE = 2;

/** Applies hierarchical LOD selections while retaining complete coverage. */
export class LodTreeScheduler extends ChunkStreamScheduler {
  constructor(options, format) {
    super(options, format);
    this.drawn = new Set();
  }
  isRangeVisible(range) {
    return this.drawn.has(range.node);
  }
  dispose() {
    super.dispose();
    this.drawn.clear();
  }
  selectRegions() {
    this.wanted.clear();
    const selected = new Set();
    const drawn = new Set();
    const cuts = new Map();
    const priority = new Map();
    const tiers = new Map();
    for (let i = 0; this.shown && i < this.selection.length; i += 2) {
      const source = this.selection[i];
      const id = this.selection[i + 1];
      if (!cuts.has(source))
        cuts.set(source, {
          metadata: this.sources.get(source).metadata,
          cut: new Set(),
          resident: new Set(),
          drawn: [],
          fading: false,
        });
      cuts.get(source).cut.add(id);
      priority.set(id, i);
    }
    for (const [id, region] of this.regions) {
      region.target = undefined;
      if (!region.current || id < 0) continue;
      const state = cuts.get(region.current.range.source);
      if (!state) continue;
      const { parents, nodeBase } = state.metadata;
      for (
        let n = id - nodeBase;
        n >= 0 && !state.resident.has(n);
        n = parents[n]
      )
        state.resident.add(n);
      if (this.fades.has(region.current)) state.fading = true;
    }
    for (const id of this.drawn) {
      const range = this.regions.get(id)?.current?.range;
      const state = range && cuts.get(range.source);
      if (state && id >= 0) state.drawn.push(id);
    }
    const need = (range, tier = LOAD_PREFETCH) => {
      if (!range.count) return;
      const region = this.regionState(range.node);
      region.target = range;
      selected.add(region);
      tiers.set(range.node, Math.max(tiers.get(range.node) ?? tier, tier));
    };
    for (const [source, state] of cuts) {
      const { metadata, cut, resident, fading } = state;
      const { parents, childOffsets, children, nodeBase, emptyCoverage } =
        metadata;
      const refined = new Set();
      // Selection is distance-ordered; each ancestor inherits its nearest target.
      for (const id of cut)
        for (
          let p = parents[id - nodeBase];
          p >= 0 && !refined.has(p);
          p = parents[p]
        ) {
          refined.add(p);
          priority.set(nodeBase + p, priority.get(id));
        }
      const rangeOf = (n) => this.nodeRange(source, nodeBase + n);
      const ready = (range) =>
        !range.count || this.regions.get(range.node)?.current?.range === range;
      const covered = new Set();
      // Each walk appends its coverage and returns whether it is complete.
      const next = [];
      const own = (range) => {
        if (range.count) next.push(range.node);
        return true;
      };
      const below = (n, visit) => {
        let complete = childOffsets[n] < childOffsets[n + 1];
        for (let i = childOffsets[n]; i < childOffsets[n + 1]; i++)
          complete = visit(children[i]) && complete;
        return complete;
      };
      // Zooming out can keep a complete finer cut while the new node loads.
      const fallback = (n) => {
        if (!resident.has(n)) return !!emptyCoverage[n];
        const range = rangeOf(n);
        return ready(range) ? own(range) : below(n, fallback);
      };
      const visit = (n) => {
        const range = rangeOf(n);
        let complete;
        if (!refined.has(n)) {
          need(range);
          complete = ready(range) ? own(range) : fallback(n);
        } else {
          const start = next.length;
          complete = below(n, visit);
          if (!complete) {
            need(range);
            if (ready(range)) {
              next.length = start;
              complete = own(range);
            }
          }
        }
        if (complete) covered.add(n);
        return complete;
      };
      for (const n of metadata.roots) visit(n);
      // Promote the next coverage/switch step; deeper requests remain prefetches.
      const prioritize = (n) => {
        const range = rangeOf(n);
        if (!refined.has(n)) {
          need(range, covered.has(n) ? LOAD_SWITCH : LOAD_VISIBLE);
        } else if (below(n, (child) => covered.has(child))) {
          for (let i = childOffsets[n]; i < childOffsets[n + 1]; i++)
            prioritize(children[i]);
        } else if (ready(range)) {
          for (let i = childOffsets[n]; i < childOffsets[n + 1]; i++) {
            const child = rangeOf(children[i]);
            if (selected.has(this.regions.get(child.node)))
              need(child, LOAD_SWITCH);
          }
        } else need(range, LOAD_VISIBLE);
      };
      for (const n of metadata.roots) prioritize(n);
      // Finish one coverage transition before beginning the next one.
      const visible = fading ? state.drawn : next;
      for (const id of visible) {
        drawn.add(id);
        need(rangeOf(id - nodeBase));
      }
    }
    if (this.shown)
      for (const chunk of this.environments) {
        const range = chunk.environmentRange;
        if (range) {
          need(range, LOAD_VISIBLE);
          drawn.add(range.node);
        }
      }
    this.drawn = drawn;
    for (const region of this.regions.values())
      if (region.pending?.data && region.target !== region.pending.range)
        region.pending = undefined;
    // Within each purpose, coarse levels load first, then nearer regions.
    const ordered = [...selected].sort(
      (a, b) =>
        tiers.get(b.target.node) - tiers.get(a.target.node) ||
        b.target.level - a.target.level ||
        (priority.get(a.target.node) ?? this.selection.length) -
          (priority.get(b.target.node) ?? this.selection.length),
    );
    // Environments without decoded ranges still fill missing coverage.
    if (this.shown)
      for (const chunk of this.environments)
        if (!chunk.environmentRange && chunk.count !== 0)
          this.wanted.add(chunk);
    for (const region of ordered) {
      if (region.current?.range !== region.target)
        this.wanted.add(this.chunks.get(region.target.file));
    }
    if (this.shown && cuts.size && !ordered.length && !this.wanted.size)
      this.resolveFirst(this);
    return ordered;
  }
}
