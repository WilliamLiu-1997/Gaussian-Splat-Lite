import { Progress } from "./progress.js";
import { IndexArray } from "./storage.js";

const float = new Float32Array(1);
const bits = new Uint32Array(float.buffer);
// An unsigned integer that orders like the float score; -0 counts as 0.
function rank(score) {
  float[0] = score + 0;
  const word = bits[0];
  return (word & 0x80000000 ? ~word : word | 0x80000000) >>> 0;
}

// Whether item (key, index) pops before item (otherKey, otherIndex).
function above(key, index, otherKey, otherIndex) {
  return key > otherKey || (key === otherKey && index > otherIndex);
}

// The pages of an IndexArray in one growing array, for heaps that stay small.
class Flat {
  constructor() {
    this.values = new Uint32Array(1024);
    this.mask = 0xffffffff;
  }
  page(index) {
    if (index + 2 > this.values.length) {
      const larger = new Uint32Array(
        Math.max(index + 2, this.values.length * 2),
      );
      larger.set(this.values);
      this.values = larger;
    }
    return this.values;
  }
  get(index) {
    return this.page(index)[index];
  }
  dispose() {}
}

// Each item is a (rank, index) pair of words, so visiting it reads one page.
// Of equal ranks, the larger index pops first.
export class Heap {
  constructor(workspace, flat = false) {
    this.items = flat ? new Flat() : new IndexArray(workspace);
    this.length = 0;
  }
  // Whether the top item pops before the item (key, index).
  before(key, index) {
    const words = this.items.page(0);
    return above(words[0], words[1], key, index);
  }
  index(i) {
    return this.items.get(i * 2 + 1);
  }
  store(i, key, index) {
    const words = this.items.page(i * 2, true);
    const offset = (i * 2) & this.items.mask;
    words[offset] = key;
    words[offset + 1] = index;
  }
  push(index, score) {
    this.pushKey(index, rank(score));
  }
  pushKey(index, key) {
    let i = this.length++;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      const words = this.items.page(parent * 2);
      const offset = (parent * 2) & this.items.mask;
      const otherKey = words[offset];
      const other = words[offset + 1];
      if (!above(key, index, otherKey, other)) break;
      this.store(i, otherKey, other);
      i = parent;
    }
    this.store(i, key, index);
  }
  pop() {
    const items = this.items;
    const result = items.get(1);
    // The popped item's key.
    this.key = items.get(0);
    const last = --this.length;
    const tail = items.page(last * 2);
    const key = tail[(last * 2) & items.mask];
    const index = tail[((last * 2) & items.mask) + 1];
    let i = 0;
    // Down to the items whose children leave the first page, one view of it
    // serves: no other page is read meanwhile, so none is evicted.
    const first = Math.min(last, (items.mask + 1) / 2);
    const top = items.page(0, true);
    let placed = false;
    while (i * 2 + 2 < first) {
      let child = i * 2 + 1;
      let childKey = top[child * 2];
      let childIndex = top[child * 2 + 1];
      const rightKey = top[child * 2 + 2];
      const rightIndex = top[child * 2 + 3];
      if (above(rightKey, rightIndex, childKey, childIndex)) {
        child++;
        childKey = rightKey;
        childIndex = rightIndex;
      }
      if (above(key, index, childKey, childIndex)) {
        placed = true;
        break;
      }
      top[i * 2] = childKey;
      top[i * 2 + 1] = childIndex;
      i = child;
    }
    while (!placed && i * 2 + 1 < last) {
      let child = i * 2 + 1;
      const left = items.page(child * 2);
      let childKey = left[(child * 2) & items.mask];
      let childIndex = left[((child * 2) & items.mask) + 1];
      if (child + 1 < last) {
        const right = items.page(child * 2 + 2);
        const rightKey = right[(child * 2 + 2) & items.mask];
        const rightIndex = right[((child * 2 + 2) & items.mask) + 1];
        if (above(rightKey, rightIndex, childKey, childIndex)) {
          child++;
          childKey = rightKey;
          childIndex = rightIndex;
        }
      }
      if (above(key, index, childKey, childIndex)) break;
      this.store(i, childKey, childIndex);
      i = child;
    }
    if (last) this.store(i, key, index);
    return result;
  }
  dispose() {
    this.items.dispose();
  }
}

// Pops the items of a heap with ties broken toward larger indices in the
// same order as the heap: the items it holds now from a sorted copy, and items
// pushed later from a second heap. Popping a sorted copy reads it in order.
export class Queue {
  constructor(heap, workspace, label) {
    this.size = heap.length;
    this.items = sortItems(heap.items, this.size, workspace, false, label);
    this.cursor = 0;
    this.fresh = new Heap(workspace);
    // The popped item's key.
    this.key = 0;
  }
  get length() {
    return this.size - this.cursor + this.fresh.length;
  }
  // Whether the next item pops before the item (key, index).
  before(key, index) {
    if (this.fresh.length && this.fresh.before(key, index)) return true;
    if (this.cursor === this.size) return false;
    const words = this.items.page(this.cursor * 2);
    const offset = (this.cursor * 2) & this.items.mask;
    return above(words[offset], words[offset + 1], key, index);
  }
  pop() {
    if (this.cursor < this.size) {
      const words = this.items.page(this.cursor * 2);
      const offset = (this.cursor * 2) & this.items.mask;
      const key = words[offset];
      const index = words[offset + 1];
      if (!this.fresh.length || !this.fresh.before(key, index)) {
        this.cursor++;
        this.key = key;
        return index;
      }
    }
    const index = this.fresh.pop();
    this.key = this.fresh.key;
    return index;
  }
  push(index, score) {
    this.fresh.push(index, score);
  }
  dispose() {
    this.items.dispose();
    this.fresh.dispose();
  }
}

// Items that a sort reads at a time, and items of a bucket that it writes
// at a time.
const BLOCK = 8192;
const RUN = 256;

// The first `count` (key, index) items of `items`, sorted by descending key
// and then index, or by key alone if `byKey`, keeping the order of items with
// equal keys: a radix sort by byte, skipping bytes that all items share.
// Items are read a block at a time, and those of a bucket written a run at
// a time: one by one, every item would look up its page.
function sortItems(items, count, workspace, byKey = false, label = undefined) {
  const first = byKey ? 4 : 0;
  const progress = label && new Progress(label, count * (10 - first));
  const counts = Array.from({ length: 8 }, () => new Float64Array(256));
  // Byte `pass` of the index, then of the key, inverted to sort descending.
  const digit = (key, index, pass) =>
    255 - (((pass < 4 ? index : key) >>> ((pass & 3) * 8)) & 255);
  const block = new Uint32Array(BLOCK * 2);
  for (let base = 0; base < count; base += BLOCK) {
    const size = Math.min(BLOCK, count - base);
    items.read(base * 2, block, size * 2);
    for (let i = 0; i < size; i++)
      for (let pass = first; pass < 8; pass++)
        counts[pass][digit(block[i * 2], block[i * 2 + 1], pass)]++;
    progress?.update(base + size);
  }
  // The items of each bucket that wait to be written.
  const runs = new Uint32Array(256 * RUN * 2);
  const filled = new Uint32Array(256);
  let source = items;
  for (let pass = first; pass < 8; pass++) {
    const cursor = counts[pass];
    if (cursor.includes(count)) continue;
    for (let b = 0, sum = 0; b < 256; b++) {
      const size = cursor[b];
      cursor[b] = sum;
      sum += size;
    }
    const sorted = new IndexArray(workspace);
    const flush = (b) => {
      sorted.write(cursor[b] * 2, runs.subarray(b * RUN * 2), filled[b] * 2);
      cursor[b] += filled[b];
      filled[b] = 0;
    };
    for (let base = 0; base < count; base += BLOCK) {
      const size = Math.min(BLOCK, count - base);
      source.read(base * 2, block, size * 2);
      for (let i = 0; i < size; i++) {
        const key = block[i * 2];
        const index = block[i * 2 + 1];
        const b = digit(key, index, pass);
        const at = (b * RUN + filled[b]) * 2;
        runs[at] = key;
        runs[at + 1] = index;
        if (++filled[b] === RUN) flush(b);
      }
      progress?.update(count * (1 + pass - first) + base + size);
    }
    for (let b = 0; b < 256; b++) if (filled[b]) flush(b);
    if (source !== items) source.dispose();
    source = sorted;
  }
  if (source !== items) {
    progress?.finish();
    return source;
  }
  const copy = new IndexArray(workspace);
  for (let base = 0; base < count; base += BLOCK) {
    const size = Math.min(BLOCK, count - base);
    items.read(base * 2, block, size * 2);
    copy.write(base * 2, block, size * 2);
    progress?.update(count * (9 - first) + base + size);
  }
  progress?.finish();
  return copy;
}

// Sorts the splats by feature size, and splats of equal size by index. Sizes,
// items and the order go a block at a time, as in sortItems().
export function sortSplats(splats, pool) {
  const workspace = splats.workspace;
  const count = splats.length;
  const progress = new Progress("Preparing splat sort", count);
  // Sorted by descending rank, the smallest feature comes first; sorting by
  // rank alone keeps splats of equal size in index order.
  const items = new IndexArray(workspace);
  const sizes = new Float32Array(BLOCK);
  const block = new Uint32Array(BLOCK * 2);
  for (let base = 0; base < count; base += BLOCK) {
    const size = Math.min(BLOCK, count - base);
    splats.sizes.read(base, sizes, size);
    for (let i = 0; i < size; i++) {
      block[i * 2] = rank(-sizes[i]);
      block[i * 2 + 1] = base + i;
    }
    items.write(base * 2, block, size * 2);
    progress.update(base + size);
  }
  progress.finish();
  const sorted = sortItems(items, count, workspace, true, "Sorting splats");
  items.dispose();
  const order = new IndexArray(workspace);
  const ordering = new Progress("Collecting splat order", count);
  const indices = new Uint32Array(BLOCK);
  for (let base = 0; base < count; base += BLOCK) {
    const size = Math.min(BLOCK, count - base);
    sorted.read(base * 2, block, size * 2);
    for (let i = 0; i < size; i++) indices[i] = block[i * 2 + 1];
    order.write(base, indices, size);
    ordering.update(base + size);
  }
  sorted.dispose();
  ordering.finish();
  splats.reorder(order, pool);
}
