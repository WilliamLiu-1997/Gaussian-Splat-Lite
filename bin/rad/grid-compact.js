import { STRIDE, store } from "./grid-order.js";

// The difference of two cells' coordinates on the axis that orders them in
// Morton order, with x varying fastest: negative when the first comes first.
function morton(a, b) {
  const below = (x, y) => x < y && x < (x ^ y);
  let high = a[0] ^ b[0];
  let difference = a[0] - b[0];
  for (let d = 1; d < 3; d++) {
    const bits = a[d] ^ b[d];
    if (!below(bits, high)) {
      high = bits;
      difference = a[d] - b[d];
    }
  }
  return difference;
}

// An independent page stays readable while output writes evict workspace pages.
export class GridRows {
  constructor(table, first, end, gone) {
    this.table = table;
    this.next = first;
    this.end = end;
    this.gone = gone;
    this.values = new Float32Array(table.items);
    this.words = new Uint32Array(this.values.buffer);
    this.key = new Int32Array(3);
    this.spans = new Uint16Array(gone ? table.items / STRIDE + 1 : 2);
  }

  load() {
    this.row = 0;
    this.size = 0;
    while (this.next < this.end && !this.size) {
      const first = this.next;
      const at = first * STRIDE;
      const n = Math.min(
        this.end - first,
        (this.table.items - (at & this.table.mask)) / STRIDE,
      );
      this.next += n;
      const spans = this.liveSpans(first, n);
      if (spans) {
        const firstLive = this.spans[0];
        const lastEnd = this.spans[spans - 1];
        this.table.stream(at + firstLive, this.values, lastEnd - firstLive);
        let written = this.spans[1] - firstLive;
        for (let i = 2; i < spans; i += 2) {
          const start = this.spans[i] - firstLive;
          const end = this.spans[i + 1] - firstLive;
          this.words.copyWithin(written, start, end);
          written += end - start;
        }
        this.size = written / STRIDE;
      }
      this.table.discard(at, this.next * STRIDE);
    }
    return this.size;
  }

  // Live runs in words, so a page needs at most one read between its live ends.
  liveSpans(first, count) {
    if (!this.gone) {
      this.spans[1] = count * STRIDE;
      return 2;
    }
    let spans = 0;
    let live = false;
    let bits = 0;
    for (let i = 0; i < count; i++) {
      const entry = first + i;
      if (!i || !(entry & 31))
        bits = this.gone.get(entry >>> 5) >>> (entry & 31);
      const keep = !(bits & 1);
      if (live !== keep) {
        this.spans[spans++] = i * STRIDE;
        live = keep;
      }
      bits >>>= 1;
    }
    if (live) this.spans[spans++] = count * STRIDE;
    return spans;
  }
}

export function mergeRows(grid, old, inserted) {
  const key = (rows) => grid.blockOf(rows.values, rows.row * STRIDE, rows.key);
  for (const source of [old, inserted]) if (source.load()) key(source);
  // Index full batches while their output pages are still cached.
  const batch = grid.pool.nodes.length;
  let written = 0;
  let indexed = 0;
  while (old.size || inserted.size) {
    const left =
      !inserted.size || (old.size && morton(old.key, inserted.key) <= 0);
    const source = left ? old : inserted;
    const other = left ? inserted : old;
    const first = source.row;
    if (!other.size) source.row = source.size;
    else {
      while (++source.row < source.size) {
        const order = morton(key(source), other.key);
        if (left ? order > 0 : order >= 0) break;
      }
    }
    const count = source.row - first;
    store(grid.entries, written, source.words, count, first);
    written += count;
    while (written - indexed >= batch) {
      grid.linkRange(indexed, indexed + batch);
      indexed += batch;
    }
    if (source.row === source.size && source.load()) key(source);
  }
  if (written > indexed) grid.linkRange(indexed, written);
  return written;
}
