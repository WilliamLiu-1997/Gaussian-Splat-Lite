// Candidate search adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { rank } from "./heap.js";
import { HALF, halfBits } from "./math.js";
import { Progress } from "./progress.js";
import { LATER } from "./splats.js";
import { IndexArray, PagedArray, Permutation } from "./storage.js";
export const NONE = 0xffffffff;
// Files over which the tables of searches spread: worker threads read their
// pages at once, and the system reads one file little faster from many.
const STRIPES = 8;
// The share of slots that cells may take. Fuller tables mean longer probes
// but fewer pages to read and write back once they no longer fit the cache.
const LOAD = 0.75;
// Sort keys that a sort reads at a time, and keys of a bucket that it
// writes at a time.
const KEYS = 4096;
const RUN = 32;
// What a sort reads and has yet to write, made by the thread that first
// sorts: worker threads search grids and never sort them.
let sorting;

// An entry holds Similarities.get()'s 13 terms: the center, covariance and
// log determinant as floats and the color as halves, which it is exactly.
// Consecutive entries of one cell form a run within each 32-entry removal
// word. The high half of BLUE stores its first bit index. LINK points to
// the preceding run.
const STRIDE = 16;
const COLOR = 10;
const BLUE = 11;
const NODE = 12;
const LINK = 13;
const WEIGHT = 14;
const pair = new Uint32Array(2);
const double = new Float64Array(pair.buffer);
// Entries are sorted by the Morton code of their cell, 4 bits per axis and
// radix pass. Cells beyond 30 bits per axis share codes.
const BITS = 30;
const SPREAD = Uint16Array.from({ length: 16 }, (_, v) => {
  let spread = 0;
  for (let bit = 0; bit < 4; bit++) spread |= ((v >> bit) & 1) << (bit * 3);
  return spread;
});

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

// A round marks cells by their low hash bits. Collisions only add a slot lookup.
export class Cells {
  constructor(bits) {
    this.mask = (1 << bits) - 1;
    this.stamps = new Uint32Array(1 << bits);
    this.stamp = 1;
  }
  clear() {
    this.stamp = (this.stamp + 1) >>> 0;
  }
  add(hash) {
    this.stamps[hash & this.mask] = this.stamp;
  }
  has(hash) {
    return this.stamps[hash & this.mask] === this.stamp;
  }
}

// A grid table that workers can read.
function newTable(workspace) {
  const table = new PagedArray(workspace, Float32Array).share(STRIPES);
  table.wordView = true;
  return table;
}

// Copies through `scratch`: fetching the target page may evict the source's.
const scratch = new Uint32Array(STRIDE);
function copy(source, from, target, to) {
  const words = source.at(from * STRIDE).words;
  const offset = (from * STRIDE) & source.mask;
  for (let w = 0; w < STRIDE; w++) scratch[w] = words[offset + w];
  const out = target.at(to * STRIDE, true).words;
  const at = (to * STRIDE) & target.mask;
  for (let w = 0; w < STRIDE; w++) out[at + w] = scratch[w];
}

// Writes the entry of splat `node` at `offset` of `values` and `words`, the
// float and word views of one memory: its terms `tuple` and its weight.
export function writeEntry(values, words, offset, node, tuple, weight) {
  for (let d = 0; d < 3; d++) values[offset + d] = tuple[d];
  for (let d = 0; d < 7; d++) values[offset + 3 + d] = tuple[6 + d];
  words[offset + COLOR] = halfBits(tuple[3]) | (halfBits(tuple[4]) << 16);
  words[offset + BLUE] = halfBits(tuple[5]);
  words[offset + NODE] = node;
  words[offset + LINK] = NONE;
  double[0] = weight;
  words[offset + WEIGHT] = pair[0];
  words[offset + WEIGHT + 1] = pair[1];
}

// Appends the `count` entries in `words` to `table` after its first `length`
// entries, the words of a page at a time: as words, every field keeps its
// bits.
function store(table, length, words, count) {
  for (let done = 0; done < count; ) {
    const index = (length + done) * STRIDE;
    const within = index & table.mask;
    const size = Math.min((count - done) * STRIDE, table.items - within);
    table
      .at(index, true)
      .words.set(words.subarray(done * STRIDE, done * STRIDE + size), within);
    done += size / STRIDE;
  }
}

// A cell's hash XORs one term per axis. Above three bits for the cell in its
// block of 2 cells per axis, a term mixes the low and high 32 bits of the
// block's coordinate: the cells of a block take consecutive slots, so the
// cells around a query lie on few cache lines.
const LOW = [73856093, 19349663, 83492791];
const HIGH = [1640531535, 1597334677, 3812015801];
function term(value, d) {
  const block = Math.floor(value / 2);
  return (
    ((Math.imul(block, LOW[d]) ^
      Math.imul(Math.floor(block / 4294967296), HIGH[d])) <<
      3) |
    ((value - block * 2) << d)
  );
}
function cellHash(x, y, z) {
  return (term(x, 0) ^ term(y, 1) ^ term(z, 2)) >>> 0;
}

// Above 2^32 slots the probe's high bit no longer fits a u32 mask.
function wrapSlot(index, mask) {
  return mask <= 0xffffffff ? (index & mask) >>> 0 : index % (mask + 1);
}

// Finds candidates in a grid's tables: the Grid itself on the main thread,
// and workers through SharedColumns. A removed entry has its bit set in
// `gone`, so that removing one leaves the pages of entries unchanged.
export class Lookup {
  constructor(entries, slots, gone, capacity, step, origin = [0, 0, 0]) {
    this.entries = entries;
    this.slots = slots;
    this.gone = gone;
    this.capacity = capacity;
    this.step = step;
    // Reused for cell lookups.
    this.inverse = 1 / step;
    this.origin = origin;
    // Overlapping searches acquire the head after its entry and link are ready.
    this.concurrent = false;
    this.terms = new Int32Array(9);
  }

  cell(value, axis) {
    return Math.floor(value * this.inverse) - this.origin[axis];
  }

  // The slot of cell (x, y, z), or the free slot for it. A slot is a cell
  // hash and its newest entry + 1, which is 0 in free slots. Keep that
  // head for find() so it does not have to look up the slot twice.
  slot(hash, x, y, z) {
    const mask = this.capacity - 1;
    // Triangular probing visits every slot of a power-of-two table.
    let stride = 0;
    for (
      let slot = wrapSlot(hash, mask);
      ;
      slot = wrapSlot(slot + ++stride, mask)
    ) {
      const words = this.slots.page(slot * 2);
      const at = this.slots.offset(slot * 2);
      const head = this.concurrent
        ? Atomics.load(words, at + 1)
        : words[at + 1];
      if (!head) {
        this.slotHead = 0;
        return slot;
      }
      if (words[at] !== hash) continue;
      const floats = this.entries.page((head - 1) * STRIDE);
      const offset = this.entries.offset((head - 1) * STRIDE);
      if (
        this.cell(floats[offset], 0) === x &&
        this.cell(floats[offset + 1], 1) === y &&
        this.cell(floats[offset + 2], 2) === z
      ) {
        this.slotHead = head;
        return slot;
      }
    }
  }

  // Copies an entry's similarity terms and then its weight into `out` and
  // returns its node.
  read(entry, out) {
    const page = this.entries.at(entry * STRIDE);
    const offset = this.entries.offset(entry * STRIDE);
    const { values, words } = page;
    for (let d = 0; d < 3; d++) out[d] = values[offset + d];
    out[3] = HALF[words[offset + COLOR] & 0xffff];
    out[4] = HALF[words[offset + COLOR] >>> 16];
    out[5] = HALF[words[offset + BLUE] & 0xffff];
    for (let d = 0; d < 7; d++) out[6 + d] = values[offset + 3 + d];
    pair[0] = words[offset + WEIGHT];
    pair[1] = words[offset + WEIGHT + 1];
    out[13] = double[0];
    return words[offset + NODE];
  }

  // Whether `entry` is removed.
  isRemoved(entry) {
    return (this.gone.get(entry >>> 5) >>> (entry & 31)) & 1;
  }

  // The best entry other than `self` in the 27 neighboring cells, scoring
  // at least `minimum`. Reverse traversal and >= keep the first forward tie.
  // With `cells`, search only marked cells and entries from `from` on.
  find(
    query,
    self,
    from = 0,
    cells = undefined,
    minimum = Number.NEGATIVE_INFINITY,
  ) {
    const qx = query[0];
    const qy = query[1];
    const qz = query[2];
    const red = query[3];
    const green = query[4];
    const blue = query[5];
    const cxx = query[6];
    const cyy = query[7];
    const czz = query[8];
    const cxy = query[9];
    const cxz = query[10];
    const cyz = query[11];
    const logDet = query[12];
    const finiteLogDet = Number.isFinite(logDet);
    const gx = this.cell(qx, 0);
    const gy = this.cell(qy, 1);
    const gz = this.cell(qz, 2);
    const terms = this.terms;
    for (let d = -1; d <= 1; d++) {
      terms[1 + d] = term(gx + d, 0);
      terms[4 + d] = term(gy + d, 1);
      terms[7 + d] = term(gz + d, 2);
    }
    const entries = this.entries;
    const gone = this.gone;
    let best = NONE;
    let metric = minimum;
    const selfWord = self >>> 5;
    const selfBit = 1 << (self & 31);
    let lowDet = Number.POSITIVE_INFINITY;
    let lowLog = 0;
    let home = NONE;
    let near = NONE;
    for (let dz = 1; dz >= -1; dz--) {
      for (let dy = 1; dy >= -1; dy--) {
        for (let dx = 1; dx >= -1; dx--) {
          const hash = (terms[1 + dx] ^ terms[4 + dy] ^ terms[7 + dz]) >>> 0;
          if (cells && !cells.has(hash)) continue;
          const slot = this.slot(hash, gx + dx, gy + dy, gz + dz);
          if (!dx && !dy && !dz) home = slot;
          const head = this.slotHead;
          let entry = head ? head - 1 : NONE;
          // Lists run from the newest entry down.
          while (entry !== NONE && entry >= from) {
            const word = entry >>> 5;
            const bits = gone.get(word) | (word === selfWord ? selfBit : 0);
            const page = entries.at(entry * STRIDE);
            const b = page.values;
            const w = page.words;
            const last = entry & 31;
            const at = entries.offset(entry * STRIDE);
            const base = at - last * STRIDE;
            const first = w[at + BLUE] >>> 16;
            const lower = Math.max(first, from - word * 32);
            let live = ~bits & (-1 << lower) & (0xffffffff >>> (31 - last));
            entry = w[at + LINK];
            while (live) {
              const bit = 31 - Math.clz32(live);
              live ^= 1 << bit;
              const o = base + bit * STRIDE;
              // The covariance sum has eight times the mean's determinant
              // and half its inverse quadratic form.
              const xx = cxx + b[o + 3];
              const yy = cyy + b[o + 4];
              const zz = czz + b[o + 5];
              const xy = cxy + b[o + 6];
              const xz = cxz + b[o + 7];
              const yz = cyz + b[o + 8];
              const minorXX = yy * zz - yz * yz;
              const minorXY = xy * zz - yz * xz;
              const minorXZ = xy * yz - yy * xz;
              const det = xx * minorXX - xy * minorXY + xz * minorXZ;
              const diag = Math.max(Math.abs(xx), Math.abs(yy), Math.abs(zz));
              const x = b[o] - qx;
              const y = b[o + 1] - qy;
              const z = b[o + 2] - qz;
              let distance;
              const otherLogDet = b[o + 9];
              if (
                finiteLogDet &&
                Number.isFinite(otherLogDet) &&
                det >= 1e-9 * Math.max(diag * diag * diag, 8e-30)
              ) {
                const quad =
                  (minorXX * x * x +
                    (xx * zz - xz * xz) * y * y +
                    (xx * yy - xy * xy) * z * z +
                    2 *
                      (-minorXY * x * y +
                        minorXZ * x * z +
                        (xy * xz - xx * yz) * y * z)) /
                  det;
                const spatial = 0.25 * quad;
                // log is monotone and each color penalty can only lower the
                // score. A strict bound keeps candidates tied with the best.
                if (
                  det >= lowDet &&
                  -(spatial + lowLog - logDet - otherLogDet) < metric
                )
                  continue;
                const shape = 0.5 * Math.log(det * 0.125);
                if (det < lowDet) {
                  lowDet = det;
                  lowLog = shape;
                }
                distance = spatial + shape - logDet - otherLogDet;
              } else {
                // Flat covariances can lose a determinant before or after
                // summing. Mean variance still gives separation a scale.
                const variance = (xx + yy + zz) / 3 || this.step * this.step;
                distance = (0.25 * (x * x + y * y + z * z)) / variance;
              }
              const color = w[o + COLOR];
              const score =
                -distance -
                (red - HALF[color & 0xffff]) ** 2 -
                (green - HALF[color >>> 16]) ** 2 -
                (blue - HALF[w[o + BLUE] & 0xffff]) ** 2;
              const value = Number.isNaN(score)
                ? Number.NEGATIVE_INFINITY
                : score;
              if (value >= metric) {
                best = word * 32 + bit;
                metric = value;
                near = slot;
              }
            }
          }
        }
      }
    }
    this.metric = metric;
    // The slots of the query's cell, if visited, and of the best's cell.
    this.home = home;
    this.near = near;
    return best;
  }
}

// The candidates of one LOD level. Each splat's similarity terms are computed
// once and its entry is stored in spatial order, so the cells around a query
// lie on few pages. A hash maps each cell to the newest entry of its list,
// keyed by the cell's hash and checked against that entry's center. Removed
// entries stay in the lists until compact() drops them.
export class Grid extends Lookup {
  constructor(similarities, step, bounds, pool) {
    const workspace = similarities.splats.workspace;
    super(
      newTable(workspace),
      new IndexArray(workspace).share(STRIPES),
      new IndexArray(workspace).share(STRIPES),
      16,
      step,
      // Anchor each axis at the point in its bounds nearest zero. A distant
      // outlier then cannot move local cells beyond the safe integer range.
      bounds.min.map((min, d) =>
        Math.floor(Math.max(min, Math.min(0, bounds.max[d])) / step),
      ),
    );
    this.similarities = similarities;
    this.workspace = workspace;
    this.pool = pool;
    this.length = 0;
    // Bumped when slots move.
    this.layout = 0;
    // Entries below `sorted` are in key order; inserted ones follow.
    this.sorted = 0;
    this.removed = 0;
    this.count = 0;
    // The blocks of the entries last sorted; see sort().
    this.cells = 0;
    // The slot, cell and cell hash of the last linked entry; -1 for none.
    this.last = -1;
    this.lastX = 0;
    this.lastY = 0;
    this.lastZ = 0;
    this.lastHash = 0;
    // Node -> entry, kept up to date by link().
    this.entryOf = new IndexArray(this.workspace);
    this.runNodes = new Uint32Array(32);
    this.tuple = new Float64Array(14);
    // Sort keys address blocks of `scale` cells per axis within the bounds:
    // single cells unless the bounds exceed 2^30 cells.
    this.minCell = bounds.min.map((value, d) => this.cell(value, d));
    const extent = Math.max(
      ...bounds.max.map(
        (value, d) => this.cell(value, d) - this.minCell[d] + 1,
      ),
    );
    const bits = Math.max(1, Math.ceil(Math.log2(extent)));
    this.scale = 2 ** Math.max(0, bits - BITS);
    this.limit = 2 ** Math.min(bits, BITS) - 1;
    this.passes = Math.ceil(Math.min(bits, BITS) / 4);
    this.a = new Int32Array(3);
    this.b = new Int32Array(3);
  }

  // The coordinates of the block of an entry's cell, into `out`.
  block(table, entry, out) {
    const values = table.page(entry * STRIDE);
    const offset = (entry * STRIDE) & table.mask;
    for (let d = 0; d < 3; d++)
      out[d] = Math.min(
        this.limit,
        Math.max(
          0,
          Math.floor(
            (this.cell(values[offset + d], d) - this.minCell[d]) / this.scale,
          ),
        ),
      );
    return out;
  }

  // Adds live splats no larger than the search step, in heap order: a batch
  // at a time, whose entries the pool's threads compute from the splats'
  // records. This thread computes those of records that are not cached.
  build(active, removed, label) {
    const progress = label && new Progress(`${label} grid`, active.length);
    const { pool, similarities } = this;
    const { nodes, results, records: values, recordWords: words } = pool;
    const { items } = active;
    // Active keys rank -size, so larger keys mean smaller splats.
    const cellKey = rank(-this.step);
    let count = 0;
    const flush = () => {
      if (count < 64) results.fill(LATER, 0, count);
      else pool.enter(similarities.splats, count);
      for (let i = 0; i < count; i++) {
        if (results[i] !== LATER) continue;
        const tuple = similarities.get(nodes[i], this.tuple);
        writeEntry(values, words, i * STRIDE, nodes[i], tuple, tuple[13]);
      }
      store(this.entries, this.length, words, count);
      this.length += count;
      count = 0;
    };
    for (let i = 0; i < active.length; i++) {
      const pair = items.page(i * 2);
      const offset = (i * 2) & items.mask;
      const key = pair[offset];
      const node = pair[offset + 1];
      if (!removed.get(node) && key >= cellKey) {
        nodes[count++] = node;
        if (count === nodes.length) flush();
      }
      if ((i & 4095) === 0) progress?.update(i);
    }
    flush();
    progress?.finish();
    this.entries = this.sort(this.entries, this.length, label);
    this.sorted = this.length;
    // The cells that the sort counted size the table of slots at once.
    this.count = this.cells;
    this.relink(label);
  }

  // Adds a merged splat and returns the hash of its cell.
  insert(node, weight, terms, slot) {
    const entry = this.length++;
    const { values, words } = this.entries.at(entry * STRIDE, true);
    const offset = (entry * STRIDE) & this.entries.mask;
    writeEntry(values, words, offset, node, terms, weight);
    this.link(entry, slot);
    return this.lastHash;
  }

  // Returns the first `length` entries of `table` stably sorted by block,
  // disposing `table` if they moved, and counts their blocks in `cells`.
  // Sorts each entry's block and position, four words, and then moves the
  // entries once. Keys are read a block at a time, and those of a bucket
  // written a run at a time: one by one, every key would look up its page.
  sort(table, length, label) {
    const passes = this.passes;
    const progress =
      label && new Progress(`${label} spatial sort`, length * (passes + 2));
    const digit = (words, o, pass) =>
      SPREAD[(words[o] >>> (pass * 4)) & 15] |
      (SPREAD[(words[o + 1] >>> (pass * 4)) & 15] << 1) |
      (SPREAD[(words[o + 2] >>> (pass * 4)) & 15] << 2);
    const counts = Array.from({ length: passes }, () => new Float64Array(4096));
    const block = this.a;
    sorting ??= {
      chunk: new Uint32Array(KEYS * 4),
      runs: new Uint32Array(4096 * RUN * 4),
      filled: new Uint16Array(4096),
      list: new Uint32Array(KEYS),
    };
    const { chunk, runs, filled, list } = sorting;
    this.cells = 0;
    let keys = new IndexArray(this.workspace);
    for (let base = 0; base < length; base += KEYS) {
      const size = Math.min(KEYS, length - base);
      for (let i = 0; i < size; i++) {
        this.block(table, base + i, block);
        const o = i * 4;
        chunk[o] = block[0];
        chunk[o + 1] = block[1];
        chunk[o + 2] = block[2];
        chunk[o + 3] = base + i;
        for (let pass = 0; pass < passes; pass++)
          counts[pass][digit(chunk, o, pass)]++;
      }
      keys.write(base * 4, chunk, size * 4);
      progress?.update(base + size);
    }
    let moved = false;
    for (let pass = 0; pass < passes; pass++) {
      const cursor = counts[pass];
      if (cursor.includes(length)) continue;
      for (let b = 0, sum = 0; b < 4096; b++) {
        const count = cursor[b];
        cursor[b] = sum;
        sum += count;
      }
      const sorted = new IndexArray(this.workspace);
      const flush = (b) => {
        sorted.write(cursor[b] * 4, runs.subarray(b * RUN * 4), filled[b] * 4);
        cursor[b] += filled[b];
        filled[b] = 0;
      };
      // A sort that failed may have left keys behind.
      filled.fill(0);
      for (let base = 0; base < length; base += KEYS) {
        const size = Math.min(KEYS, length - base);
        keys.consume(base * 4, chunk, size * 4);
        for (let i = 0; i < size; i++) {
          const o = i * 4;
          const b = digit(chunk, o, pass);
          const at = (b * RUN + filled[b]) * 4;
          runs[at] = chunk[o];
          runs[at + 1] = chunk[o + 1];
          runs[at + 2] = chunk[o + 2];
          runs[at + 3] = chunk[o + 3];
          if (++filled[b] === RUN) flush(b);
        }
        progress?.update(length * (pass + 1) + base + size);
      }
      for (let b = 0; b < 4096; b++) if (filled[b]) flush(b);
      keys.dispose();
      keys = sorted;
      moved = true;
    }
    if (!moved) {
      keys.dispose();
      progress?.finish();
      return table;
    }
    const indices = new IndexArray(this.workspace);
    // The block of the key before, to count where blocks change.
    let x = -1;
    let y = -1;
    let z = -1;
    for (let base = 0; base < length; base += KEYS) {
      const size = Math.min(KEYS, length - base);
      keys.consume(base * 4, chunk, size * 4);
      for (let i = 0; i < size; i++) {
        const o = i * 4;
        if (chunk[o] !== x || chunk[o + 1] !== y || chunk[o + 2] !== z) {
          x = chunk[o];
          y = chunk[o + 1];
          z = chunk[o + 2];
          this.cells++;
        }
        list[i] = chunk[o + 3];
      }
      indices.write(base, list, size);
      progress?.update(length * (passes + 1) + base + size);
    }
    keys.dispose();
    progress?.finish();
    const permutation = new Permutation(
      this.workspace,
      indices,
      length,
      label && `${label} spatial order`,
    );
    indices.dispose();
    const sorted = permutation.apply(table, STRIDE, this.pool, {
      words: true,
      label: label && `${label} spatial reorder`,
    });
    permutation.dispose();
    return sorted;
  }

  // Drops removed entries and merges the inserted ones, sorted, into the
  // rest. Entries with equal keys keep their order.
  compact() {
    const old = this.entries;
    let inserted = newTable(this.workspace);
    let added = 0;
    for (let entry = this.sorted; entry < this.length; entry++)
      if (!this.isRemoved(entry)) copy(old, entry, inserted, added++);
    inserted = this.sort(inserted, added);
    this.entries = newTable(this.workspace);
    let length = 0;
    for (let i = 0, j = 0; ; ) {
      while (i < this.sorted && this.isRemoved(i)) i++;
      if (i === this.sorted && j === added) break;
      if (
        j === added ||
        (i < this.sorted &&
          morton(this.block(old, i, this.a), this.block(inserted, j, this.b)) <=
            0)
      )
        copy(old, i++, this.entries, length++);
      else copy(inserted, j++, this.entries, length++);
    }
    old.dispose();
    inserted.dispose();
    this.gone.dispose();
    this.gone = new IndexArray(this.workspace).share(STRIPES);
    this.length = this.sorted = length;
    this.removed = 0;
    this.relink();
  }

  // Rebuilds the lists in entry order. Entries of a cell are in insertion
  // order, so each list runs from the newest entry to the oldest.
  relink(label) {
    const progress = label && new Progress(`${label} indexing`, this.length);
    this.slots.dispose();
    this.slots = new IndexArray(this.workspace).share(STRIPES);
    // Compaction keeps at most the cells there were.
    this.capacity = 16;
    while (this.capacity * LOAD <= this.count) this.capacity *= 2;
    this.count = 0;
    this.last = -1;
    this.layout++;
    for (let entry = 0; entry < this.length; ) {
      if ((entry & 4095) === 0) progress?.update(entry);
      entry = this.link(entry, NONE, this.length);
    }
    progress?.finish();
  }

  // Link consecutive entries in one cell and removal word, up to `end`.
  // A single insertion publishes just its own entry.
  link(entry, hint = NONE, end = entry + 1) {
    const page = this.entries.at(entry * STRIDE);
    const offset = (entry * STRIDE) & this.entries.mask;
    const x = this.cell(page.values[offset], 0);
    const y = this.cell(page.values[offset + 1], 1);
    const z = this.cell(page.values[offset + 2], 2);
    // Entries in spatial order often share the last entry's cell.
    let slot = this.last;
    let head = entry; // One-based head when the previous cell matches.
    if (hint !== NONE) {
      slot = hint;
      const words = this.slots.page(slot * 2);
      const at = this.slots.offset(slot * 2);
      this.lastHash = words[at];
      head = words[at + 1];
    } else if (
      slot < 0 ||
      x !== this.lastX ||
      y !== this.lastY ||
      z !== this.lastZ
    ) {
      if (
        !Number.isSafeInteger(x) ||
        !Number.isSafeInteger(y) ||
        !Number.isSafeInteger(z)
      )
        throw new Error(
          "Splat coordinates exceed the LOD grid's integer range",
        );
      this.lastHash = cellHash(x, y, z);
      slot = this.slot(this.lastHash, x, y, z);
      head = this.slotHead;
    }
    const at = this.slots.offset(slot * 2);
    const { values, words: entryWords } = this.entries.at(entry * STRIDE, true);
    let first = entry & 31;
    let previous = head ? head - 1 : NONE;
    if (first && previous === entry - 1) {
      first = entryWords[offset - STRIDE + BLUE] >>> 16;
      previous = entryWords[offset - STRIDE + LINK];
    }
    const limit = Math.min(end - entry, 32 - (entry & 31));
    let count = 0;
    let o = offset;
    do {
      this.runNodes[count++] = entryWords[o + NODE];
      entryWords[o + BLUE] = (entryWords[o + BLUE] & 0xffff) | (first << 16);
      entryWords[o + LINK] = previous;
      o += STRIDE;
    } while (
      count < limit &&
      this.cell(values[o], 0) === x &&
      this.cell(values[o + 1], 1) === y &&
      this.cell(values[o + 2], 2) === z
    );
    // Updating the node map may evict the entry page.
    for (let i = 0; i < count; i++)
      this.entryOf.set(this.runNodes[i], entry + i);
    const words = this.slots.page(slot * 2, true);
    if (!head) words[at] = this.lastHash;
    if (this.workspace.finishSearch)
      Atomics.store(words, at + 1, entry + count);
    else words[at + 1] = entry + count;
    this.last = slot;
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    if (!head && ++this.count >= this.capacity * LOAD) this.grow();
    return entry + count;
  }

  grow() {
    this.workspace.finishSearch?.();
    this.last = -1;
    this.layout++;
    const old = this.slots;
    const capacity = this.capacity;
    this.capacity *= 2;
    this.slots = new IndexArray(this.workspace).share(STRIPES);
    const mask = this.capacity - 1;
    for (let i = 0; i < capacity; i++) {
      const head = old.get(i * 2 + 1);
      if (!head) continue;
      const hash = old.get(i * 2);
      let slot = wrapSlot(hash, mask);
      let stride = 0;
      while (this.slots.get(slot * 2 + 1))
        slot = wrapSlot(slot + ++stride, mask);
      this.slots.set(slot * 2, hash);
      this.slots.set(slot * 2 + 1, head);
    }
    old.dispose();
  }

  remove(entry) {
    const word = entry >>> 5;
    this.gone.set(word, this.gone.get(word) | (1 << (entry & 31)));
    this.removed++;
  }

  // The entry of `node`, which must be in the grid.
  entry(node) {
    return this.entryOf.get(node);
  }

  // Compacts the grid once half of it is removed. Entries keep their
  // positions until the next call.
  tidy() {
    if (this.removed * 2 > this.length) this.compact();
  }

  dispose() {
    this.entries.dispose();
    this.slots.dispose();
    this.gone.dispose();
    this.entryOf.dispose();
  }
}
