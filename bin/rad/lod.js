// LOD construction adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { Cells, Grid, NONE, cellHash } from "./grid.js";
import { Heap, Queue, sortSplats } from "./heap.js";
import { SCALE, halfBits, rotation } from "./math.js";
import { MISS, ROUND, hint } from "./parallel.js";
import { Progress } from "./progress.js";
import { SH_DIMS, Similarities } from "./splats.js";
import { IndexArray, PagedArray, Permutation } from "./storage.js";

export function buildLod(splats, lodBase, pool) {
  const initial = splats.length;
  const workspace = splats.workspace;
  sortSplats(splats, pool);
  mergeLevels(splats, pool);
  splats.mergeSh(initial, pool);
  const root = splats.length - 1;

  // Children always precede their binary parent: the two of merged splat
  // `index` are entries 2 * (index - initial) and the next of `children`. A
  // merged splat is kept if its weight is at least lodBase times its
  // children's largest feature; one that is not passes that feature on, and
  // its kept descendants become children of its kept ancestor.
  const features = new PagedArray(workspace, Float64Array);
  const selection = new Progress("Selecting LOD nodes", splats.length);
  let retainedCount = initial;
  for (let index = 0; index < initial; index++) {
    features.set(index, splats.weight.get(index));
    if ((index & 4095) === 0) selection.update(index);
  }
  // A bit for each merged splat.
  const kept = new IndexArray(workspace);
  for (let index = initial; index < splats.length; index++) {
    let maximum = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < 2; c++) {
      const child = splats.children.get((index - initial) * 2 + c);
      maximum = Math.max(maximum, features.get(child));
    }
    const feature = splats.weight.get(index);
    const retained = index === root || feature >= maximum * lodBase;
    features.set(index, retained ? feature : maximum);
    if (retained) {
      retainedCount++;
      const bit = index - initial;
      kept.set(bit >>> 5, kept.get(bit >>> 5) | (1 << (bit & 31)));
    }
    if ((index & 4095) === 0) selection.update(index);
  }
  features.dispose();
  splats.weight.dispose();
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
        if (lengths[top] < limit) {
          next.push(logical);
          next.push(index);
          next.push(bitsOf(lengths[top]));
          continue;
        }
        if (index < initial) continue;
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
        // Each child's size is read once, at random, for both uses.
        for (let c = 0; c < count; c++) {
          const length = sizes.get(list[c]);
          order.push(list[c]);
          ordered.push(length);
          const at = top + count - 1 - c;
          logicals[at] = start + c;
          indices[at] = list[c];
          lengths[at] = length;
        }
        top += count;
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
  chunkTree(splats, order, first, counts, ordered, pool);
  order.dispose();
}

// Merges the splats level by level into a binary tree, adding the merged
// splats after the leaves.
function mergeLevels(splats, pool) {
  const initial = splats.length;
  const workspace = splats.workspace;
  // Merged splats lie within the leaves' bounds.
  const { bounds, sizes } = splats;
  const removed = new PagedArray(workspace, Uint8Array);
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
  // Cells that merges of the round have added entries to, and the blocks of
  // 4 cells per axis next to them: queries in other blocks skip the check.
  const added = new Cells(18);
  const near = new Cells(20);
  for (
    let level = Math.ceil(Math.log2(Math.max(sizes.get(0), 0.000001)));
    ;
    level++
  ) {
    const step = 2 ** level;
    if (!Number.isFinite(step)) throw new Error("LOD scale overflow");
    // The leaves are sorted by feature, so find this level's range without
    // an extra linear pass just to count its work.
    let low = frontier;
    let high = initial;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sizes.get(middle) <= step) low = middle + 1;
      else high = middle;
    }
    const { grid, queue } = Progress.inline(() => {
      const adding = new Progress(`Preparing level ${level}`, low - frontier);
      const previous = frontier;
      while (frontier < low) {
        active.push(frontier, -sizes.get(frontier));
        frontier++;
        if ((frontier & 4095) === 0) adding.update(frontier - previous);
      }
      adding.finish();
      const grid = new Grid(similarities, step, bounds, pool);
      grid.build(active, removed, `Level ${level}`);
      const queue = new Queue(
        active,
        workspace,
        `Sorting level ${level} queue`,
      );
      return { grid, queue };
    });
    active.dispose();
    const next = new Heap(workspace);
    const detail = () =>
      `${frontier}/${initial} leaves, ${queue.length} pending, ${splats.length} splats`;
    const progress = new Progress(`Level ${level}`, queue.length, detail());
    // Rounds of merges in heap order. Workers search for the candidates of
    // the next popped splats against the grid at the start of the round.
    // Committing them in order, a search still holds unless its candidate is
    // gone or a merge of the round added a candidate at least as good, and
    // splats that merges add pop as they would one by one.
    while (queue.length) {
      grid.tidy();
      const limit = Math.min(
        ROUND,
        Math.max(256, Math.floor(grid.count / 100)),
      );
      let count = 0;
      while (count < limit && queue.length) {
        const index = queue.pop();
        if (removed.get(index)) continue;
        pool.nodes[count] = index;
        pool.entries[count] = grid.entry(index);
        keys[count] = queue.key;
        count++;
      }
      // Entries from here on are added by the round; slots stay put while
      // the layout does.
      const start = grid.length;
      const layout = grid.layout;
      if (count < 64) pool.results.fill(MISS, 0, count);
      else pool.search(grid, count);
      added.clear();
      near.clear();
      for (let t = 0; t < count; ) {
        let index;
        let self;
        let key;
        let best = MISS;
        let task = -1;
        if (queue.length && queue.before(keys[t], pool.nodes[t])) {
          index = queue.pop();
          key = queue.key;
          if (removed.get(index)) continue;
          self = grid.entry(index);
        } else {
          index = pool.nodes[t];
          self = pool.entries[t];
          key = keys[t];
          best = pool.results[t];
          task = t++;
          if (removed.get(index)) continue;
        }
        // A search that the main thread need not do passes on the terms.
        if (best === MISS) grid.read(self, query);
        else
          for (let d = 0; d < 14; d++) query[d] = pool.queries[task * 14 + d];
        if (best !== MISS && best !== NONE && grid.isRemoved(best)) best = MISS;
        const inverse = grid.inverse;
        if (
          best !== MISS &&
          near.has(
            cellHash(
              Math.floor(Math.floor(query[0] * inverse) / 4),
              Math.floor(Math.floor(query[1] * inverse) / 4),
              Math.floor(Math.floor(query[2] * inverse) / 4),
            ),
          )
        ) {
          const better = grid.find(query, index, start, added);
          if (better !== NONE) {
            const metric = pool.metrics[task];
            if (best === NONE || grid.metric > metric) {
              best = better;
              task = -1;
            } else if (grid.metric === metric) best = MISS;
          }
        }
        if (best === MISS) {
          best = grid.find(query, index);
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
        removed.set(index, 1);
        removed.set(other, 1);
        grid.remove(self);
        grid.remove(best);
        const feature = sizes.get(merged);
        if (feature > step) next.push(merged, -feature);
        else {
          const terms =
            task < 0 ? undefined : copy(pool.terms, task * 13, terms13, 13);
          // The slot of its cell where the search found it.
          const slot =
            task < 0
              ? hint(grid, splats.merged, query, candidate)
              : layout === grid.layout
                ? pool.hints[task]
                : NONE;
          added.add(
            grid.insert(merged, splats.weight.get(merged), terms, slot),
          );
          const { lastX: x, lastY: y, lastZ: z } = grid;
          const x1 = Math.floor((x + 1) / 4);
          const y1 = Math.floor((y + 1) / 4);
          const z1 = Math.floor((z + 1) / 4);
          for (let bz = Math.floor((z - 1) / 4); bz <= z1; bz++)
            for (let by = Math.floor((y - 1) / 4); by <= y1; by++)
              for (let bx = Math.floor((x - 1) / 4); bx <= x1; bx++)
                near.add(cellHash(bx, by, bz));
          queue.push(merged, -feature);
        }
      }
      // At round boundaries the queue only shrinks: each new merged item
      // replaces at least one popped item. Include those items until drained.
      progress.update(progress.total - queue.length, detail());
    }
    grid.dispose();
    queue.dispose();
    progress.finish(detail());
    active = next;
    if (frontier === initial && active.length <= 1) break;
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

// Lays out the tree in chunks of 65536 splats and moves every column into
// that order. Children become consecutive rows: childStart is then the row of
// a splat's first child. `sizes` are the splats' sizes in logical order.
function chunkTree(splats, order, first, counts, sizes, pool) {
  const workspace = splats.workspace;
  const nodes = splats.length;
  for (const column of [splats.childStart, splats.childCount, splats.children])
    column.dispose();
  // Chunking reads records at random by logical index, so it reads them in
  // logical order, where splats of a subtree lie close together.
  const logical = new Permutation(
    workspace,
    order,
    nodes,
    "Preparing LOD order",
  );
  splats.records = logical.apply(
    splats.records,
    16,
    pool,
    false,
    "Reordering LOD nodes",
  );
  logical.dispose();
  // The row of each splat's first child.
  const starts = new PagedArray(workspace, Float64Array);
  const indices = new IndexArray(workspace);
  indices.push(0);
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
  const add = (heap, index) => {
    const size = sizes.get(index);
    if (counts.get(index)) heap.push(index, size);
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
      starts.set(parent, indices.length);
      const firstChild = first.get(parent);
      for (let child = firstChild; child < firstChild + count; child++) {
        indices.push(child);
        add(heap, child);
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
        splats.read(item(i), record);
        centers.write(i * 3, record, 3);
        rotation(record, r);
        const sx = Math.max(0.001, SCALE[halfBits(record[7])]) * 1.5;
        const sy = Math.max(0.001, SCALE[halfBits(record[8])]) * 1.5;
        const sz = Math.max(0.001, SCALE[halfBits(record[9])]) * 1.5;
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
  if (indices.length !== order.length)
    throw new Error("Incomplete LOD tree ordering");
  chunking.finish();
  const chunked = new Permutation(
    workspace,
    indices,
    order.length,
    "Preparing chunk order",
  );
  splats.records = chunked.apply(
    splats.records,
    16,
    pool,
    false,
    "Reordering chunk splats",
  );
  splats.childCount = chunked.apply(
    counts,
    1,
    pool,
    false,
    "Reordering child counts",
  );
  splats.childStart = chunked.apply(
    starts,
    1,
    pool,
    false,
    "Reordering child offsets",
  );
  chunked.dispose();
  // The SH coefficients are still in the order of mergeSh().
  if (splats.maxSh) {
    const shOrder = new Progress("Collecting LOD SH order", indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices.set(i, splats.shRow(order.get(indices.get(i))));
      if ((i & 4095) === 0) shOrder.update(i);
    }
    shOrder.finish();
    splats.shOrder.dispose();
    const nodeOrder = new Permutation(
      workspace,
      indices,
      nodes,
      "Preparing LOD SH order",
    );
    for (let band = 0; band < splats.maxSh; band++)
      splats.sh[band] = nodeOrder.apply(
        splats.sh[band],
        SH_DIMS[band],
        pool,
        false,
        `Reordering LOD SH${band + 1}`,
      );
    nodeOrder.dispose();
  }
  first.dispose();
  splats.length = indices.length;
  indices.dispose();
}
