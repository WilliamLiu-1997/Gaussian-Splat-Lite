// LOD construction adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { EncodingRanges } from "./encoding.js";
import { Cells, Grid, NONE } from "./grid.js";
import { Heap, Queue, rank, sortSplats } from "./heap.js";
import { HALF, SCALE, rotation } from "./math.js";
import { MISS, ROUND, hint } from "./parallel.js";
import { Progress } from "./progress.js";
import { SHAPE_WORDS, Similarities, shCodeCount } from "./splats.js";
import { IndexArray, PagedArray, Permutation } from "./storage.js";

// Grid cell size and candidate size limit relative to the level (at least 1).
const SEARCH_SCALE = 2;

// A conservative filter of 2-cell blocks. Each new parent can affect queries
// in exactly two blocks per axis. Hash collisions only add a grid check.
// Larger rounds need more slots to avoid collisions, but the filter shares
// the memory budget with the page cache.
const Y_STRIDE = 73856093;
const Z_STRIDE = 19349663;
const MIN_NEAR_BITS = 17;
const MAX_NEAR_BITS = 20;
const blockSlot = (x, y, z) =>
  (x | 0) + Math.imul(y, Y_STRIDE) + Math.imul(z, Z_STRIDE);
const BLOCK_OFFSETS = [0, Y_STRIDE, Z_STRIDE, Y_STRIDE + Z_STRIDE];

class RemovedNodes extends IndexArray {
  has(node) {
    return (this.get(node >>> 5) >>> (node & 31)) & 1;
  }

  add(node) {
    const word = node >>> 5;
    this.page(word, true)[word & this.mask] |= 1 << (node & 31);
  }
}

export function buildLod(splats, lodBase, pool, shCodebook) {
  const initial = splats.length;
  // N retained leaves produce 2N - 1 nodes in the binary tree.
  if (initial > 0x80000000)
    throw new Error(
      "Filtered input exceeds the RAD LOD limit of 2147483648 splats",
    );
  const workspace = splats.workspace;
  splats.prepareShapes();
  // mergeSh() reads the SH bands in ascending order after the tree is built.
  workspace.rest(splats.sh.slice(0, splats.maxSh));
  splats.shOrder = sortSplats(splats, pool, splats.maxSh > 0);
  mergeLevels(splats, pool, 1, splats.maxSh);
  const root = splats.length - 1;

  // Children always precede their binary parent: the two of merged splat
  // `index` are entries 2 * (index - initial) and the next of `children`. A
  // merged splat is kept if its weight is at least lodBase times its
  // children's largest feature; one that is not passes that feature on, and
  // its kept descendants become children of its kept ancestor. Once read,
  // each weight can be replaced by the feature it passes on.
  const features = splats.weight;
  const selection = new Progress("Selecting LOD nodes", splats.length);
  let retainedCount = initial;
  selection.update(initial);
  // A bit for each merged splat.
  const kept = new IndexArray(workspace);
  for (let index = initial; index < splats.length; index++) {
    let maximum = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < 2; c++) {
      const child = splats.children.get((index - initial) * 2 + c);
      maximum = Math.max(maximum, features.get(child));
    }
    const feature = features.get(index);
    const retained = index === root || feature >= maximum * lodBase;
    if (retained) {
      retainedCount++;
      const bit = index - initial;
      kept.set(bit >>> 5, kept.get(bit >>> 5) | (1 << (bit & 31)));
    } else features.set(index, maximum);
    if ((index & 4095) === 0) selection.update(index);
  }
  features.dispose();
  selection.finish(`${retainedCount} nodes retained`);

  // Ordering reads sizes at random, from a column without the rest of each
  // record, and lists them in logical order for chunkTree().
  const sizes = splats.sizes;
  // A splat's logical index is its position in `order`. Its children get
  // consecutive logical indices: `first` and the `counts` - 1 after it.
  const order = new IndexArray(workspace);
  const first = new IndexArray(workspace);
  const counts = new IndexArray(workspace);
  const ordered = new PagedArray(workspace, Float32Array);
  order.push(root);
  ordered.push(sizes.get(root));
  // The splats to visit, by logical index, splat and size: the frontier of a
  // pass as triples of words, and a stack within it.
  let frontier = new IndexArray(workspace);
  frontier.push(0);
  frontier.push(root);
  frontier.push(bitsOf(sizes.get(root)));
  let logicals = new Uint32Array(64);
  let indices = new Uint32Array(64);
  let lengths = new Float32Array(64);
  let list = new Uint32Array(64);
  let walk = new Uint32Array(64);
  const ordering = new Progress("Ordering LOD tree", retainedCount);
  let visited = 0;
  for (let limit = sizes.get(root); ; limit /= 4) {
    const next = new IndexArray(workspace);
    for (let f = 0; f < frontier.length; f += 3) {
      logicals[0] = frontier.get(f);
      indices[0] = frontier.get(f + 1);
      lengths[0] = floatOf(frontier.get(f + 2));
      let top = 1;
      while (top) {
        if ((++visited & 4095) === 0) ordering.update(order.length);
        top--;
        const logical = logicals[top];
        const index = indices[top];
        if (index < initial) continue;
        if (lengths[top] < limit) {
          next.push(logical);
          next.push(index);
          next.push(bitsOf(lengths[top]));
          continue;
        }
        // Its children: the kept splats below it, through those not kept.
        let count = 0;
        let depth = 0;
        walk[depth++] = index;
        while (depth) {
          const pair = (walk[--depth] - initial) * 2;
          for (let c = 0; c < 2; c++) {
            const child = splats.children.get(pair + c);
            const bit = child - initial;
            if (child < initial || (kept.get(bit >>> 5) >>> (bit & 31)) & 1) {
              if (count === list.length) list = grow(list, count);
              list[count++] = child;
            } else {
              if (depth === walk.length) walk = grow(walk, depth);
              walk[depth++] = child;
            }
          }
        }
        if (count > 65535)
          throw new Error("LOD child count exceeds RAD u16 limit");
        sort(list, count);
        const start = order.length;
        first.set(logical, start);
        counts.set(logical, count);
        if (top + count > logicals.length) {
          logicals = grow(logicals, top, top + count);
          indices = grow(indices, top, top + count);
          lengths = grow(lengths, top, top + count);
        }
        // The sorted children start with leaves. Only parents need a stack slot.
        let parents = count;
        for (let c = 0; c < count; c++) {
          const child = list[c];
          const length = sizes.get(child);
          order.push(child);
          ordered.push(length);
          if (child < initial) {
            parents--;
            continue;
          }
          const at = top + count - 1 - c;
          logicals[at] = start + c;
          indices[at] = child;
          lengths[at] = length;
        }
        top += parents;
      }
    }
    frontier.dispose();
    if (!next.length) {
      next.dispose();
      break;
    }
    frontier = next;
  }
  sizes.dispose();
  kept.dispose();
  ordering.finish();
  if (!splats.maxSh) splats.children.dispose();
  const chunks = chunkTree(splats, order, first, counts, ordered, pool);
  order.dispose();
  return reorderChunks(splats, chunks, pool, shCodebook);
}

// Starting with size-sorted leaves, append binary parents in merge order
// until exactly target nodes remain.
export function mergeLevels(splats, pool, target, saveBlends) {
  const initial = splats.length;
  const totalMerges = initial - target;
  const end = initial + totalMerges;
  const mergeCount = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumSignificantDigits: 3,
  });
  const workspace = splats.workspace;
  if (saveBlends) splats.blend = new PagedArray(workspace, Float64Array);
  // Merged splats lie within the leaves' bounds.
  const { bounds, sizes } = splats;
  const removed = new RemovedNodes(workspace);
  const similarities = new Similarities(splats);
  let active = new Heap(workspace);
  let frontier = 0;
  // The similarity terms and weight of a popped splat and of the splat it
  // merges with.
  const query = new Float64Array(14);
  const candidate = new Float64Array(14);
  const keys = new Uint32Array(ROUND);
  // A worker's merged record and its terms.
  const merge = new Float32Array(16);
  const terms13 = new Float32Array(13);
  // Cells receiving new entries in this round, and blocks within their reach.
  const added = new Cells(18);
  const nearBits = Math.max(
    MIN_NEAR_BITS,
    Math.min(MAX_NEAR_BITS, Math.floor(Math.log2(workspace.budget / 4096))),
  );
  const near = new Uint8Array(1 << nearBits);
  // Levels double the size of the splats that initiate merges, from the
  // smallest leaf's. Progress numbers them and shows about how many there
  // are: until all leaves are in and a level spans the scene, which can be
  // one off.
  const first = Math.ceil(Math.log2(Math.max(sizes.get(0), 0.000001)));
  const span = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  const reach = Math.max(sizes.get(initial - 1), span, 0.000001);
  const levels = Math.max(1, Math.ceil(Math.log2(reach)) - first + 1);
  for (let level = first; ; level++) {
    const step = 2 ** level;
    const searchStep = step * SEARCH_SCALE;
    if (!Number.isFinite(searchStep)) throw new Error("LOD scale overflow");
    const stepKey = rank(-step);
    const name = `LOD level ${level - first + 1}/≈${levels}`;
    const levelStart = splats.length;
    const mergePercent = () =>
      splats.length === end
        ? 100
        : Math.min(99.99, ((splats.length - initial) * 100) / totalMerges);
    const detail = () => {
      const count = splats.length - levelStart;
      const overall = mergePercent();
      return ` | ${mergeCount.format(count)} ${count === 1 ? "merge" : "merges"} | overall ${overall.toFixed(2)}%`;
    };
    const { grid, queue, progress } = Progress.inline(() => {
      // The leaves are sorted by feature, so find this level's range without
      // an extra linear pass just to count its work.
      let low = frontier;
      let high = initial;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (sizes.get(middle) <= searchStep) low = middle + 1;
        else high = middle;
      }
      const adding = new Progress(`Preparing ${name}`, low - frontier);
      const previous = frontier;
      while (frontier < low) {
        active.push(frontier, -sizes.get(frontier));
        frontier++;
        if ((frontier & 4095) === 0) adding.update(frontier - previous);
      }
      adding.finish();
      const grid = new Grid(similarities, searchStep, bounds, pool);
      grid.build(active, removed, name);
      const queue = new Queue(active, workspace, `Sorting ${name} queue`);
      const progress = new Progress(`Merging ${name}`, queue.length, detail);
      progress.phasePercent = mergePercent;
      return { grid, queue, progress };
    });
    active.dispose();
    const next = new Heap(workspace);
    // Rounds of merges in heap order. Workers search for the candidates of
    // the next popped splats while this thread commits completed chunks.
    // Committing them in order, a search still holds unless its candidate is
    // gone or a merge of the round added a better candidate, and
    // splats that merges add pop as they would one by one.
    while (queue.length && splats.length < end) {
      let limit = ROUND;
      let count = 0;
      while (count < limit && queue.length) {
        const index = queue.pop();
        if (removed.has(index)) continue;
        if (queue.key < stepKey) {
          next.pushKey(index, queue.key);
          continue;
        }
        if (!count)
          limit = grid.prepareRound(queue, stepKey, end - splats.length);
        pool.nodes[count] = index;
        keys[count] = queue.key;
        count++;
      }
      grid.gatherEntries(count);
      // Entries from here on are added by the round; slots stay put while
      // the layout does.
      const start = grid.length;
      const layout = grid.layout;
      const predicting = pool.search(grid, count);
      let ready = predicting ? 0 : count;
      let nearMask = 0;
      if (predicting) {
        const bits = Math.ceil(Math.log2(count * 64));
        nearMask = (1 << Math.max(MIN_NEAR_BITS, Math.min(nearBits, bits))) - 1;
        added.clear();
        near.fill(0, 0, nearMask + 1);
      }
      for (let t = 0; t < count; ) {
        let index;
        let self;
        let key;
        let best = MISS;
        let task = -1;
        if (queue.length && queue.before(keys[t], pool.nodes[t])) {
          index = queue.pop();
          key = queue.key;
          if (removed.has(index)) continue;
          self = grid.entry(index);
        } else {
          if (t === ready) ready = pool.readyThrough(t, count);
          index = pool.nodes[t];
          self = pool.entries[t];
          key = keys[t];
          best = pool.results[t];
          task = t++;
          if (removed.has(index)) continue;
        }
        const offset = task * 14;
        if (best === MISS) grid.read(self, query);
        else if (best !== NONE && grid.isRemoved(best)) {
          copy(pool.queries, offset, query, 14);
          best = MISS;
        } else if (
          grid.length > start &&
          near[
            blockSlot(
              Math.floor(grid.cell(pool.queries[offset], 0) / 2),
              Math.floor(grid.cell(pool.queries[offset + 1], 1) / 2),
              Math.floor(grid.cell(pool.queries[offset + 2], 2) / 2),
            ) & nearMask
          ]
        ) {
          copy(pool.queries, offset, query, 14);
          const metric = pool.metrics[task];
          const better = grid.find(query, self, start, added, metric);
          if (better !== NONE && (best === NONE || grid.metric > metric)) {
            best = better;
            task = -1;
          }
        }
        if (best === MISS) {
          best = grid.find(query, self);
          task = -1;
        }
        if (best === NONE) {
          // Its key in the queue is its feature's.
          next.pushKey(index, key);
          continue;
        }
        const other =
          task < 0 ? grid.read(best, candidate) : pool.partners[task];
        // A search that still holds was merged with the same inputs.
        const merged =
          task < 0
            ? splats.merge(index, other, query, candidate)
            : splats.append(
                index,
                other,
                copy(pool.records, task * 16, merge, 16),
                pool.blends[task * 2],
                pool.blends[task * 2 + 1],
              );
        if (splats.length === end) break;
        removed.add(index);
        removed.add(other);
        grid.remove(self);
        grid.remove(best);
        // Merger already rounds these fields to their stored precision.
        const record = task < 0 ? splats.merged : merge;
        const feature = record[14];
        if (feature > step) next.push(merged, -feature);
        if (feature <= searchStep) {
          const terms =
            task < 0
              ? similarities.terms(record, terms13)
              : copy(pool.terms, task * 13, terms13, 13);
          // The slot of its cell where the search found it.
          const slot =
            task < 0
              ? hint(grid, splats.merged, query, candidate)
              : layout === grid.layout
                ? pool.hints[task]
                : NONE;
          const hash = grid.insert(merged, record[15] * record[3], terms, slot);
          if (predicting && t < count) {
            added.add(hash);
            const { lastX: x, lastY: y, lastZ: z } = grid;
            const first = blockSlot(
              Math.floor((x - 1) / 2),
              Math.floor((y - 1) / 2),
              Math.floor((z - 1) / 2),
            );
            for (const offset of BLOCK_OFFSETS) {
              near[(first + offset) & nearMask] = 1;
              near[(first + offset + 1) & nearMask] = 1;
            }
          }
          if (feature <= step) queue.push(merged, -feature);
        }
      }
      workspace.finishSearch?.();
      // At round boundaries the queue only shrinks: each new merged item
      // replaces at least one popped item. Include those items until drained.
      progress.update(progress.total - queue.length, detail);
    }
    grid.dispose();
    queue.dispose();
    progress.finish(detail);
    active = next;
    if (splats.length === end) break;
  }
  active.dispose();
  removed.dispose();
}

// A copy of the first `count` values of `array` with room for `size`.
function grow(array, count, size = count + 1) {
  const larger = new array.constructor(size * 2);
  larger.set(array.subarray(0, count));
  return larger;
}

// Sizes in words of an IndexArray.
const float = new Float32Array(1);
const word = new Uint32Array(float.buffer);
function bitsOf(value) {
  float[0] = value;
  return word[0];
}
function floatOf(bits) {
  word[0] = bits;
  return float[0];
}

// Copies `count` values of `source` from `from` into `out`, and returns it.
function copy(source, from, out, count) {
  for (let i = 0; i < count; i++) out[i] = source[from + i];
  return out;
}

// Sorts the first `count` values ascending.
function sort(values, count) {
  if (count > 32) {
    values.subarray(0, count).sort();
    return;
  }
  for (let i = 1; i < count; i++) {
    const value = values[i];
    let j = i;
    for (; j > 0 && values[j - 1] > value; j--) values[j] = values[j - 1];
    values[j] = value;
  }
}

// Lays out the tree in chunks of 65536 splats and returns their original
// indices in chunk order. Children become consecutive rows: childStart is
// then the row of a splat's first child. `sizes` are in logical order.
function chunkTree(splats, order, first, counts, sizes, pool) {
  const workspace = splats.workspace;
  const nodes = splats.length;
  for (const column of [splats.childStart, splats.childCount]) {
    column.dispose();
    column.length = order.length;
  }
  // Chunking reads shapes at random by logical index, so it reads them in
  // logical order, where splats of a subtree lie close together. The
  // records move once, into chunk order.
  splats.writeShapes();
  const logical = new Permutation(
    workspace,
    order,
    nodes,
    "Preparing LOD order",
  );
  const shapes = logical.apply(splats.shapes, SHAPE_WORDS, pool, {
    label: "Reordering LOD shapes",
  });
  splats.shapes = undefined;
  logical.dispose();
  const shape = new Uint32Array(SHAPE_WORDS);
  const center = new Float32Array(shape.buffer, 0, 3);
  // Emit original splat indices directly. Once a parent has its chunk row,
  // reuse its consumed order entry to write its child range when it pops.
  const indices = new IndexArray(workspace);
  indices.push(order.get(0));
  order.set(0, 0);
  const top = new IndexArray(workspace);
  top.push(0);
  const batches = [top];
  const record = new Float64Array(16);
  const r = new Float64Array(9);
  // Splats without children add no rows when they pop, so they wait outside
  // the heap with the number of pops before them: one pops unless all later
  // pops rank above it.
  let leaves = new Uint32Array(1024);
  let leafSizes = new Float32Array(1024);
  let since = new Uint32Array(1024);
  let waiting = 0;
  // The splats that pop from the heap, and their sizes.
  let popped = new Uint32Array(1024);
  let poppedSizes = new Float32Array(1024);
  let pops = 0;
  const add = (heap, index, count = counts.get(index)) => {
    const size = sizes.get(index);
    if (count) heap.push(index, size);
    else {
      if (waiting === leaves.length) {
        leaves = grow(leaves, waiting);
        leafSizes = grow(leafSizes, waiting);
        since = grow(since, waiting);
      }
      leaves[waiting] = index;
      leafSizes[waiting] = size;
      since[waiting++] = pops;
    }
  };
  const chunking = new Progress("Arranging LOD chunks", order.length);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    batches[b] = undefined;
    const heap = new Heap(workspace, true);
    waiting = 0;
    pops = 0;
    for (let i = 0; i < batch.length; i++) add(heap, batch.get(i));
    batch.dispose();
    const start = indices.length;
    let end = Math.ceil((start + 8192) / 65536) * 65536;
    // The splats without children that stay: the last `stayed` of `leaves`,
    // from `stay` on.
    let stay = 0;
    let stayed = 0;
    while (heap.length) {
      const parent = heap.pop();
      const count = counts.get(parent);
      if (pops === popped.length) {
        popped = grow(popped, pops);
        poppedSizes = grow(poppedSizes, pops);
      }
      popped[pops] = parent;
      poppedSizes[pops++] = sizes.get(parent);
      if (indices.length === start)
        end = Math.max(end, Math.ceil((start + count) / 65536) * 65536);
      if (indices.length + count > end) {
        heap.push(parent, sizes.get(parent));
        // A waiting splat stays if it ranks below the lowest of the pops
        // after it. From the last to wait, which follows the fewest pops.
        let k = pops;
        let low = Number.POSITIVE_INFINITY;
        let lowIndex = 0;
        stay = waiting;
        for (let i = waiting - 1; i >= 0; i--) {
          for (; k > since[i]; k--) {
            const size = poppedSizes[k - 1];
            if (size < low || (size === low && popped[k - 1] < lowIndex)) {
              low = size;
              lowIndex = popped[k - 1];
            }
          }
          if (
            leafSizes[i] < low ||
            (leafSizes[i] === low && leaves[i] < lowIndex)
          )
            leaves[--stay] = leaves[i];
        }
        stayed = waiting - stay;
        break;
      }
      const parentRow = order.get(parent);
      splats.childStart.set(parentRow, indices.length);
      splats.childCount.set(parentRow, count);
      const firstChild = first.get(parent);
      for (let child = firstChild; child < firstChild + count; child++) {
        const childCount = counts.get(child);
        const row = indices.length;
        indices.push(order.get(child));
        if (childCount) order.set(child, row);
        add(heap, child, childCount);
      }
      if ((pops & 4095) === 0) chunking.update(indices.length);
    }
    // What stays: the heap, then the splats without children.
    const rest = heap.length + stayed;
    const item = (i) =>
      i < heap.length ? heap.index(i) : leaves[stay + i - heap.length];
    if (rest) {
      const min = [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ];
      const max = [
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ];
      // The centers decide the groups below; keep them for that.
      const centers = new PagedArray(workspace, Float32Array);
      for (let i = 0; i < rest; i++) {
        if ((i & 4095) === 0) chunking.update(indices.length);
        shapes.read(item(i) * SHAPE_WORDS, shape, SHAPE_WORDS);
        for (let d = 0; d < 3; d++) record[d] = center[d];
        record[10] = HALF[shape[4] >>> 16];
        record[11] = HALF[shape[5] & 0xffff];
        record[12] = HALF[shape[5] >>> 16];
        record[13] = HALF[shape[6]];
        centers.write(i * 3, record, 3);
        rotation(record, r);
        const sx = Math.max(0.001, SCALE[shape[3] & 0xffff]) * 1.5;
        const sy = Math.max(0.001, SCALE[shape[3] >>> 16]) * 1.5;
        const sz = Math.max(0.001, SCALE[shape[4] & 0xffff]) * 1.5;
        for (let d = 0; d < 3; d++) {
          const half =
            Math.abs(r[d]) * sx +
            Math.abs(r[3 + d]) * sy +
            Math.abs(r[6 + d]) * sz;
          min[d] = Math.min(min[d], record[d] - half);
          max[d] = Math.max(max[d], record[d] + half);
        }
      }
      const extents = min.map((value, d) => max[d] - value);
      const split = min.map((value, d) => (value + max[d]) * 0.5);
      const axis =
        extents[0] >= extents[1] && extents[0] >= extents[2]
          ? 0
          : extents[1] >= extents[2]
            ? 1
            : 2;
      const binary = extents[axis] >= 3 * Math.min(...extents);
      const groups = Array.from(
        { length: binary ? 2 : 8 },
        () => new IndexArray(workspace),
      );
      for (let i = 0; i < rest; i++) {
        if ((i & 4095) === 0) chunking.update(indices.length);
        const center = centers.read(i * 3, record, 3);
        const group = binary
          ? Number(center[axis] >= split[axis])
          : Number(center[0] >= split[0]) +
            2 * Number(center[1] >= split[1]) +
            4 * Number(center[2] >= split[2]);
        groups[group].push(item(i));
      }
      centers.dispose();
      const sequence = binary
        ? groups[0].length >= groups[1].length
          ? [0, 1]
          : [1, 0]
        : [0, 1, 3, 2, 6, 7, 5, 4];
      for (const index of sequence) {
        if (groups[index].length) batches.push(groups[index]);
        else groups[index].dispose();
      }
    }
    heap.dispose();
    chunking.update(indices.length);
  }
  sizes.dispose();
  shapes.dispose();
  first.dispose();
  counts.dispose();
  if (indices.length !== order.length)
    throw new Error("Incomplete LOD tree ordering");
  chunking.finish();
  return indices;
}

// Moves retained records and SH into chunk order, collecting encoding ranges
// and any clustering weights while each output window is pinned.
function reorderChunks(splats, indices, pool, shCodebook) {
  const workspace = splats.workspace;
  const nodes = splats.length;
  const length = indices.length;
  const moved = new Permutation(
    workspace,
    splats.maxSh ? indices : indices.consumingRange(),
    nodes,
    "Preparing chunk splat order",
  );
  if (!splats.maxSh) indices.dispose();
  const ranges = new EncodingRanges();
  const weights =
    splats.maxSh && shCodebook !== 0 && shCodeCount(length, shCodebook) < length
      ? new Float64Array(splats.records.items / 16)
      : undefined;
  const analyze = (records, start, end) => {
    for (let base = start; base < end; ) {
      const offset = records.offset(base * 16);
      const count = Math.min(end - base, (records.items - offset) / 16);
      const rows = records
        .page(base * 16)
        .subarray(offset, offset + count * 16);
      ranges.add(rows);
      if (weights) {
        for (let i = 0; i < count; i++)
          weights[i] = rows[i * 16 + 15] * rows[i * 16 + 3];
        splats.weight.write(base, weights, count);
      }
      base += count;
    }
  };
  splats.records = moved.apply(splats.records, 16, pool, {
    label: "Reordering chunk splats",
    visit: analyze,
  });
  moved.dispose();
  if (splats.maxSh) splats.mergeSh(indices, pool);
  splats.length = length;
  return ranges.format();
}
