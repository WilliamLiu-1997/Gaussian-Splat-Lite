import { Progress } from "./progress.js";
import { PagedArray } from "./storage.js";

export const STRIDE = 16;
export const SPREAD = Uint16Array.from({ length: 16 }, (_, v) => {
  let spread = 0;
  for (let bit = 0; bit < 4; bit++) spread |= ((v >> bit) & 1) << (bit * 3);
  return spread;
});

// Append count rows starting at first in the source, preserving their raw bits.
export function store(table, length, words, count, first = 0) {
  for (let done = 0; done < count; ) {
    const index = (length + done) * STRIDE;
    const within = index & table.mask;
    const size = Math.min((count - done) * STRIDE, table.items - within);
    const source = (first + done) * STRIDE;
    const dest = table.at(index, true).words;
    if (size === STRIDE) {
      for (let w = 0; w < STRIDE; w++) dest[within + w] = words[source + w];
    } else if (!source && size === words.length) dest.set(words, within);
    else dest.set(words.subarray(source, source + size), within);
    done += size / STRIDE;
  }
}

// Bits that differ between the blocks of the rows going into one sort.
export class BlockRange {
  constructor() {
    this.first = undefined;
    this.mask = new Int32Array(3);
  }

  include(block) {
    this.first ??= block.slice();
    for (let d = 0; d < 3; d++) this.mask[d] |= this.first[d] ^ block[d];
  }

  // The highest varying Morton bits, most significant first.
  leadingBits(limit) {
    const bits = [];
    const highest = 31 - Math.clz32(this.mask[0] | this.mask[1] | this.mask[2]);
    for (let shift = highest; shift >= 0; shift--) {
      for (let axis = 2; axis >= 0; axis--) {
        if (!(this.mask[axis] & (1 << shift))) continue;
        bits.push({ axis, shift });
        if (bits.length === limit) return bits;
      }
    }
    return bits;
  }
}

function bucketOf(block, bits) {
  let key = 0;
  for (let i = 0; i < bits.length; i++) {
    const { axis, shift } = bits[i];
    key = (key << 1) | ((block[axis] >>> shift) & 1);
  }
  return key;
}

// A stable high-bit partition keeps equal Morton keys in insertion order.
// All partitions reuse pages in one scratch column, including on disk.
export function sortLargeGrid(
  grid,
  table,
  length,
  label,
  knownRange,
  prepareRuns,
) {
  const { workspace } = grid;
  const rows = table.items / STRIDE;
  const values = new Float32Array(table.items);
  const words = new Uint32Array(values.buffer);
  const xyz = grid.a;
  const progress = label && new Progress(label, length * 2);
  const freePages = [];
  let nextPage = 0;
  let counted = false;
  let written = 0;
  let cells = 0;

  function scan(source, pages, count, visit, discard = true) {
    for (let base = 0; base < count; base += rows) {
      const page = pages ? pages[base / rows] : base / rows;
      const index = page * source.items;
      const size = Math.min(rows, count - base);
      source.stream(index, values, size * STRIDE);
      if (discard) source.discard(index, index + source.items);
      // The rows are now in values, so a child bucket can reuse this page.
      if (pages) freePages.push(page);
      visit(size, base);
    }
    if (pages) pages.length = 0;
  }

  function column(size = 0) {
    const array = new PagedArray(workspace, Float32Array, size);
    array.wordView = true;
    return array;
  }

  function emit(size) {
    prepareRuns?.(values, words, 0, written, written + size);
    store(output, written, words, size);
    written += size;
    progress?.update(length + written);
  }

  function partition(source, pages, count, range) {
    // Constant coordinate bits would leave buckets empty and force extra passes.
    const bits = range.leadingBits(6);
    if (!bits.length) {
      scan(source, pages, count, emit);
      cells++;
      return;
    }
    if (count * STRIDE * 4 <= workspace.capacity / 2) {
      const local = column();
      scan(source, pages, count, (size, base) =>
        store(local, base, words, size),
      );
      const sorted = grid.sort(local, count);
      cells += Math.max(1, grid.cells);
      scan(sorted, undefined, count, emit);
      sorted.dispose();
      return;
    }

    const bins = new Array(1 << bits.length);
    scan(source, pages, count, (size, base) => {
      for (let i = 0; i < size; i++) {
        const offset = i * STRIDE;
        grid.blockOf(values, offset, xyz);
        const key = bucketOf(xyz, bits);
        bins[key] ??= { pages: [], count: 0, range: new BlockRange() };
        const bin = bins[key];
        bin.range.include(xyz);
        const row = bin.count++ & (rows - 1);
        if (!row) {
          const page = freePages.pop() ?? nextPage++;
          bin.pages.push(page);
          staged.whole(page * staged.items);
        }
        const page = bin.pages[bin.pages.length - 1];
        const dest = staged.at(page * staged.items, true).words;
        const at = row * STRIDE;
        for (let w = 0; w < STRIDE; w++) dest[at + w] = words[offset + w];
      }
      if (source === table && !counted) progress?.update(base + size);
    });
    if (source === table) source.dispose();
    for (const bin of bins)
      if (bin) partition(staged, bin.pages, bin.count, bin.range);
  }

  // Few varying bits let us count exact Morton keys and write rows straight
  // to their final positions. Keep the bucket cursors within the page cache.
  function scatter(bits) {
    if (bits.length > 10) return false;
    function key(offset) {
      return bucketOf(grid.blockOf(values, offset, xyz), bits);
    }
    const cursor = new Float64Array(2 ** bits.length);
    scan(
      table,
      undefined,
      length,
      (size, base) => {
        for (let i = 0; i < size; i++) cursor[key(i * STRIDE)]++;
        progress?.update(base + size);
      },
      false,
    );

    counted = true;

    // Consecutive small buckets can share a page. Count the most distinct
    // pages their forward-only cursors could occupy simultaneously.
    let tails = 0;
    let lastPage = -1;
    let occupied = 0;
    for (let k = 0, sum = 0; k < cursor.length; k++) {
      const count = cursor[k];
      cursor[k] = sum;
      if (!count) continue;
      occupied++;
      const page = Math.max(lastPage + 1, Math.floor(sum / rows));
      sum += count;
      if (page * rows < sum) {
        lastPage = page;
        tails++;
      }
    }
    if (tails * values.byteLength > workspace.capacity * 0.75) return false;

    scan(table, undefined, length, (size, base) => {
      for (let i = 0; i < size; i++) {
        const offset = i * STRIDE;
        const target = cursor[key(offset)]++ * STRIDE;
        const dest = output.at(target, true).words;
        const at = target & output.mask;
        for (let w = 0; w < STRIDE; w++) dest[at + w] = words[offset + w];
      }
      progress?.update(length + base + size);
    });
    cells = occupied;
    table.dispose();
    return true;
  }

  const range = knownRange ?? new BlockRange();
  if (!knownRange) {
    scan(
      table,
      undefined,
      length,
      (size) => {
        for (let i = 0; i < size; i++)
          range.include(grid.blockOf(values, i * STRIDE, xyz));
      },
      false,
    );
  }
  const bits = range.leadingBits(11);
  if (!bits.length) {
    grid.cells = 1;
    progress?.finish();
    return table;
  }

  const output = column(length * STRIDE).share(table.stripes);
  const staged = column();
  if (!scatter(bits)) partition(table, undefined, length, range);
  staged.dispose();
  grid.cells = cells;
  progress?.finish();
  return output;
}
