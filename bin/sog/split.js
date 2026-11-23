import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { WorkerGroup, clusterers, computers } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import {
  IndexArray,
  PAGE_BYTES,
  PagedArray,
  sharedBuffer,
} from "../rad/storage.js";
import {
  POSITION_BATCH_ROWS as BATCH,
  SPLIT_BUFFER_ROWS as BUFFERED,
  SPLIT_HEAP_MB as HEAP_MB,
  SPLIT_SCAN_ROWS as SCAN,
  SPLIT_MEMORY_SHARE as SHARE,
  SPLIT_TASKS_PER_WORKER,
  SPLIT_STRETCH_ROWS as STRETCH,
} from "./lod-config.js";
import { sortMorton } from "./morton.js";
import { Positions } from "./positions.js";
import { Centers, divide } from "./spatial-order.js";
import {
  CUT_BYTES,
  CUT_SUFFIX_BYTES,
  Cut,
  binRange,
  boundsOf,
  partRange,
  splitRange,
} from "./spatial.js";

// Bytes of a scanned row: its center and part.
const SCANNED_BYTES = 16;
// Per leaf row in Splitter.arrange(): level, index, xyz and Morton key.
const ARRANGE_BYTES = 4 + 4 + 12 + 8;
// The most rows of an array in a WebAssembly memory of 4 GiB.
const MOST = Math.floor(0xffff0000 / 12);

// Splits nodes of the centers in the order, both in shared memory, as is
// `ids`, the row of each center. Nodes own separate ranges of the order, so
// threads split them at once; so do the stretches of a large node's rows,
// whose boxes and bins add up to the node's.
class Splitter {
  constructor(centers, order, ids, starts, check) {
    this.rows = new Centers(centers, check);
    this.order = order;
    this.ids = ids;
    this.starts = starts;
    this.cursors = new Uint32Array(starts.length);
    this.check = check;
    // A part's levels, its rows and centers level by level, and the keys
    // that sort a level's rows; see arrange(). They are kept from part to
    // part, so that a thread takes no more than the largest part needs.
    this.levels = new Uint32Array(0);
    this.indices = new Uint32Array(0);
    this.positions = new Float32Array(0);
    this.keys = new BigUint64Array(0);
  }

  // Split regions to the row limit, then arrange each leaf by LOD.
  tree({ node, limit }) {
    const { rows, order } = this;
    const pending = [node];
    while (pending.length) {
      this.check();
      const next = pending.pop();
      const { start, count } = next;
      next.bound = boundsOf(rows, order, start, count);
      if (count <= limit) {
        this.arrange(next);
        continue;
      }
      divide(next, splitRange(rows, order, start, count, next.bound));
      pending.push(...next.children);
    }
    return node;
  }

  // Puts the rows of the part `node` side by side level by level, each
  // level's in the Morton order of their centers, as a chunk holds them.
  // The order holds level-local row indices and lods holds their counts.
  arrange(node) {
    const { start, count } = node;
    const { ids, order, starts, cursors } = this;
    const centers = this.rows.values;
    if (count > this.levels.length) {
      this.levels = new Uint32Array(count);
      this.indices = new Uint32Array(count);
      this.positions = new Float32Array(count * 3);
      this.keys = new BigUint64Array(count);
    }
    const { levels, indices, positions, keys } = this;
    const lods = {};
    for (let i = 0; i < count; i++) {
      // The last level that starts at or before the row.
      const row = ids[order[start + i]];
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (starts[middle] <= row) low = middle;
        else high = middle - 1;
      }
      levels[i] = low;
      if (cursors[low]++ === 0) lods[low] = 0;
    }
    // Integer keys visit only the occupied levels, in ascending order.
    let offset = 0;
    for (const level in lods) {
      lods[level] = cursors[level];
      cursors[level] = offset;
      offset += lods[level];
    }
    for (let i = 0; i < count; i++) {
      const id = order[start + i];
      const level = levels[i];
      const at = cursors[level]++;
      indices[at] = ids[id] - starts[level];
      for (let d = 0; d < 3; d++) positions[at * 3 + d] = centers[id * 3 + d];
    }
    for (const level in lods) {
      const end = cursors[level];
      const first = end - lods[level];
      sortMorton(
        indices.subarray(first, end),
        positions.subarray(first * 3, end * 3),
        keys,
        order,
        start + first,
      );
      cursors[level] = 0;
    }
    node.lods = lods;
  }

  // The box of the centers of a stretch of rows.
  box({ start, count }) {
    return boundsOf(this.rows, this.order, start, count);
  }

  // The bins of a stretch of rows of a node with the box `bound`.
  bins({ start, count, bound }) {
    const cut = new Cut(bound);
    binRange(this.rows, this.order, start, count, cut);
    return { sizes: cut.sizes, mins: cut.mins, maxs: cut.maxs };
  }

  // Moves the rows of a stretch that lie before the cut to its front, and
  // returns how many there are.
  part({ start, count, axis, value }) {
    return partRange(this.rows, this.order, start, count, axis, value) - start;
  }

  handle(job) {
    return this[job.kind](job);
  }
}

// After every stretch of a node's rows has its rows before the cut in front,
// `fronts[i]` of them: swaps the other rows that lie before the node's
// middle with the fronts that lie after it, and returns the middle.
function gatherFronts(order, stretches, fronts) {
  let middle = stretches[0].start;
  for (const front of fronts) middle += front;
  let low = 0;
  let other = stretches[0].start + fronts[0];
  let high = stretches.length - 1;
  let front = stretches[high].start + fronts[high] - 1;
  for (;;) {
    while (other >= stretches[low].start + stretches[low].count) {
      if (++low === stretches.length) return middle;
      other = stretches[low].start + fronts[low];
    }
    while (front < stretches[high].start) {
      if (--high < 0) return middle;
      front = stretches[high].start + fronts[high] - 1;
    }
    if (other >= middle || front < middle) return middle;
    const row = order[other];
    order[other++] = order[front];
    order[front--] = row;
  }
}

// Splits the `roots`, nodes of `centers` in `order` with the rows `ids`, on
// `threads` worker threads, or on this thread without any. `advance(rows)`
// hears of the rows that are split.
async function splitShared(
  workspace,
  centers,
  order,
  ids,
  roots,
  limit,
  starts,
  threads,
  advance,
) {
  const check = () => workspace.check();
  const group = new WorkerGroup(
    new URL(import.meta.url),
    threads,
    {
      splitter: true,
      centers,
      order,
      ids,
      starts,
      cancelled: workspace.cancelled,
    },
    new Splitter(centers, order, ids, starts, check),
    "Splitting",
    HEAP_MB,
  );
  // A node of more than `grain` rows is cut here, with a stretch of its rows
  // for each thread at a time; smaller nodes go whole to a thread. On this
  // thread alone, a root is split to the end at once.
  const grain = threads
    ? Math.max(
        limit,
        STRETCH,
        Math.ceil(order.length / threads / SPLIT_TASKS_PER_WORKER),
      )
    : order.length;
  try {
    await new Promise((resolve, reject) => {
      // Requests wait for a thread in their order.
      const waiting = [];
      const idle = [...group.threads];
      const pump = () => {
        while (waiting.length && idle.length) {
          const { request, done } = waiting.shift();
          const worker = idle.pop();
          Promise.resolve()
            .then(() => group.request(worker, request))
            .then((result) => {
              idle.push(worker);
              done(result);
              pump();
            })
            .catch(reject);
        }
      };
      const run = (request) =>
        new Promise((done) => {
          waiting.push({ request, done });
          pump();
        });
      const split = async (node) => {
        check();
        if (node.count <= grain) {
          const tree = { kind: "tree", node, limit };
          Object.assign(node, await run(tree));
          advance(node.count);
          return;
        }
        const stretches = [];
        for (let at = 0; at < node.count; at += STRETCH)
          stretches.push({
            start: node.start + at,
            count: Math.min(STRETCH, node.count - at),
          });
        const each = (request) =>
          Promise.all(
            stretches.map((stretch) => run({ ...request, ...stretch })),
          );
        const [bound, ...boxes] = await each({ kind: "box" });
        for (const box of boxes)
          for (let d = 0; d < 3; d++) {
            bound.min[d] = Math.min(bound.min[d], box.min[d]);
            bound.max[d] = Math.max(bound.max[d], box.max[d]);
          }
        node.bound = bound;
        const cut = new Cut(bound);
        await Promise.all(
          stretches.map(async (stretch) => {
            cut.merge(await run({ kind: "bins", bound, ...stretch }));
          }),
        );
        let middle;
        if (cut.choose(node.count)) {
          const fronts = await each({
            kind: "part",
            axis: cut.axis,
            value: cut.value,
          });
          middle = gatherFronts(order, stretches, fronts);
          if (middle === node.start || middle === node.start + node.count)
            throw new Error("Spatial split produced an empty child");
        } else {
          // Coincident centers: the first half by row, as splitRange() does.
          order.subarray(node.start, node.start + node.count).sort();
          middle = node.start + Math.floor(node.count / 2);
        }
        divide(node, middle);
        return Promise.all(node.children.map(split));
      };
      Promise.all(roots.map(split)).then(resolve, reject);
    });
  } finally {
    await group.close();
  }
}

// A part of the rows whose centers pass by in order: its node once its
// rows are counted, and the box of its centers while it is to be cut.
const newPart = () => ({
  node: undefined,
  rows: 0,
  box: {
    min: [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
    max: [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  },
  cut: undefined,
  // The first of its two parts once it is cut.
  first: 0,
});

// Counts a center in `part` and grows the part's box.
function tally(part, values, at) {
  const { min, max } = part.box;
  part.rows++;
  for (let d = 0; d < 3; d++) {
    min[d] = Math.min(min[d], values[at + d]);
    max[d] = Math.max(max[d], values[at + d]);
  }
}

// Passes over a batch of centers, three values a row, with the part of each
// row in `which`. Threads take batches at once: boxes, bins and counts of
// the batches add up to those of all rows.
class Scanner {
  constructor(check) {
    this.check = check;
  }

  // The bins of the batch's rows of each part in `cuts`, with the box of
  // the part's centers.
  bins({ values, which, rows, cuts }) {
    const of = [];
    for (const { part, bound } of cuts) of[part] = new Cut(bound);
    for (let i = 0; i < rows; i++) {
      const cut = of[which[i]];
      if (cut) cut.add(values, i * 3);
    }
    return cuts.map(({ part }) => {
      const { sizes, mins, maxs } = of[part];
      return { sizes, mins, maxs };
    });
  }

  // Moves the batch's rows of each part in `cuts` to the part's first new
  // part, `first`, or to the next: those before the cut go to the first,
  // and of coincident centers the next `half` rows. Returns whether rows
  // moved, and for each of `cuts` the rows and boxes of its two parts and
  // what is left of `half`.
  move({ values, which, rows, cuts }) {
    const of = [];
    for (const cut of cuts)
      of[cut.part] = { ...cut, parts: [newPart(), newPart()] };
    let moved = false;
    for (let i = 0; i < rows; i++) {
      const cut = of[which[i]];
      if (!cut) continue;
      const before =
        cut.axis < 0 ? cut.half-- > 0 : values[i * 3 + cut.axis] < cut.value;
      const side = before ? 0 : 1;
      which[i] = cut.first + side;
      tally(cut.parts[side], values, i * 3);
      moved = true;
    }
    return {
      moved,
      cuts: cuts.map(({ part }) => ({
        parts: of[part].parts,
        half: of[part].half,
      })),
    };
  }

  handle(job) {
    this.check();
    return this[job.kind](job);
  }
}

// Adds the rows and the box of `other` to those of `part`.
function add(part, other) {
  part.rows += other.rows;
  for (let d = 0; d < 3; d++) {
    part.box.min[d] = Math.min(part.box.min[d], other.box.min[d]);
    part.box.max[d] = Math.max(part.box.max[d], other.box.max[d]);
  }
}

// Cuts the parts of more than `fit` rows; the first of `parts` holds all
// rows. Passes over the centers in their order find the same boxes, cuts
// and counts as cutting in memory does, two passes a level, on worker
// threads a batch at a time. `where` gets the part of every row, and
// `advance(rows)` hears of the rows of every pass.
async function cutLarge(workspace, positions, where, parts, fit, advance) {
  const { length } = positions;
  const check = () => workspace.check();
  // Open parts are disjoint and each has at least fit + 1 rows. A scan
  // builds their bins locally and the main thread accumulates the results.
  const bins = Math.floor(length / (fit + 1)) * CUT_BYTES;
  const batchBytes = SCAN * SCANNED_BYTES;
  const extra = bins + CUT_SUFFIX_BYTES;
  const bytes = HEAP_MB * 1024 ** 2 + batchBytes + bins;
  const most = Math.ceil(length / SCAN);
  // As many threads as leave the centers and parts of all rows cached, so
  // that the passes read them from memory. If none do, the passes read
  // files whatever the threads, and as many as there is room for go.
  const cached = computers(
    workspace,
    bytes,
    extra + length * SCANNED_BYTES,
    most,
  );
  const threads = clusterers(
    workspace,
    bytes,
    extra,
    cached || most,
    extra + batchBytes + bins,
  );
  const group = new WorkerGroup(
    new URL(import.meta.url),
    threads,
    { scanner: true, cancelled: workspace.cancelled },
    new Scanner(check),
    "Splitting",
    HEAP_MB,
  );
  try {
    // A batch of centers and parts for each thread.
    const buffers = group.threads.map(() => sharedBuffer(batchBytes));
    // Runs `scan` over all centers, a batch for each thread at a time, or
    // `ordered`, batch after batch; `taken` gets what each batch returns.
    const pass = async (scan, taken, ordered = false) => {
      let base = 0;
      const batches = async (worker, thread) => {
        const values = new Float32Array(buffers[thread], 0, SCAN * 3);
        const which = new Uint32Array(buffers[thread], SCAN * 12, SCAN);
        while (base < length) {
          const from = base;
          const rows = Math.min(SCAN, length - from);
          base += rows;
          positions.read(from, values, rows);
          where.read(from, which, rows);
          const batch = { ...scan, values, which, rows };
          taken(await group.request(worker, batch), from, which, rows);
          advance(rows);
        }
      };
      if (ordered) await batches(group.threads[0], 0);
      else await Promise.all(group.threads.map(batches));
    };
    // The root holds all rows, in the box that their centers gave.
    parts[0].rows = length;
    parts[0].box = {
      min: [...positions.box.min],
      max: [...positions.box.max],
    };
    for (let open = [parts[0]]; open.length; ) {
      for (const part of open) part.cut = new Cut(part.box);
      const bins = open.map((part) => ({
        part: parts.indexOf(part),
        bound: part.box,
      }));
      await pass({ kind: "bins", cuts: bins }, (batch) =>
        batch.forEach((binned, i) => open[i].cut.merge(binned)),
      );
      // Coincident centers divide by row, the first half first: their
      // batches go in order.
      let ordered = false;
      const cuts = open.map((part, i) => {
        part.first = parts.length;
        parts.push(newPart(), newPart());
        const chosen = part.cut.choose(part.node.count);
        ordered ||= !chosen;
        return {
          part: bins[i].part,
          first: part.first,
          axis: part.cut.axis,
          value: part.cut.value,
          half: chosen ? 0 : Math.floor(part.node.count / 2),
        };
      });
      await pass(
        { kind: "move", cuts },
        (batch, from, which, rows) => {
          batch.cuts.forEach((cut, i) => {
            add(parts[cuts[i].first], cut.parts[0]);
            add(parts[cuts[i].first + 1], cut.parts[1]);
            cuts[i].half = cut.half;
          });
          if (batch.moved) where.write(from, which, rows);
        },
        ordered,
      );
      const next = [];
      for (const part of open) {
        const { node } = part;
        const children = [parts[part.first], parts[part.first + 1]];
        if (!children[0].rows || !children[1].rows)
          throw new Error("Spatial split produced an empty child");
        node.bound = part.box;
        divide(node, node.start + children[0].rows);
        part.cut = part.box = part.node = undefined;
        children.forEach((child, i) => {
          child.node = node.children[i];
          if (child.node.count > fit) next.push(child);
          else child.box = undefined;
        });
      }
      open = next;
    }
  } finally {
    await group.close();
  }
  // The threads are gone: the cache may take their memory.
  workspace.settle();
  workspace.expect(0);
}

// Split the combined levels into regions. Each level's leaves and their
// Morton-ordered rows are collected together in write order.
// Parts too large for the memory budget are first partitioned by cutLarge().
export async function buildRegions(rows, limit) {
  const { workspace, levels, length, starts } = rows;
  const root = { start: 0, count: length };
  const leavesByLevel = levels.map(() => []);
  let leafCount = 0;
  workspace.settle();
  // Region IDs span all levels until arrange() converts them to per-level rows.
  const RowId = length - 1 > 0xffffffff ? Float64Array : Uint32Array;
  const gatheredBytes = 12 + 4 + RowId.BYTES_PER_ELEMENT;
  const scratchBytes = (rows) =>
    Math.min(rows, limit) * ARRANGE_BYTES +
    (rows > limit ? CUT_BYTES + CUT_SUFFIX_BYTES : 0);
  const room = workspace.room;
  // Leave room for one local splitter and the padding of the three buffers.
  const gatherRoom = Math.min(
    room * SHARE,
    room - scratchBytes(length) - 3 * PAGE_BYTES,
  );
  const fit = Math.max(
    limit,
    Math.min(MOST, Math.floor(gatherRoom / gatheredBytes)),
  );
  // Progress counts passes over the rows: one each to put the parts side by
  // side and to split them. Cutting what does not fit takes two passes a
  // level; it is counted with twice the levels that even halves take, and
  // never beyond.
  const cutting =
    length > fit ? length * 4 * Math.ceil(Math.log2(length / fit)) : 0;
  const total = 2 * length + cutting;
  const progress = new Progress("Partitioning regions", total);
  let done = 0;
  const advance = (rows, most = Number.POSITIVE_INFINITY) => {
    done = Math.min(done + rows, most);
    progress.update(done);
  };
  let where;
  let order;
  let gathered;
  const arranged = new IndexArray(workspace);
  arranged.length = length;

  async function gatherParts() {
    if (length <= fit) return [root];

    const positions = new Positions(rows);
    // Every row starts in the root's part, 0.
    where = new PagedArray(workspace, Uint32Array, length);
    const parts = [newPart()];
    parts[0].node = root;
    await cutLarge(workspace, positions, where, parts, fit, (rows) =>
      advance(rows, cutting),
    );
    done = cutting;
    const which = new Uint32Array(BATCH);
    // Every part's centers go to its place in `gathered`, and its rows to
    // its place in the order, through a small buffer for each part.
    order = new PagedArray(workspace, RowId, length);
    gathered = new PagedArray(workspace, Float32Array, length * 3);
    for (const part of parts) {
      if (!part.node) continue;
      part.centers = new Float32Array(BUFFERED * 3);
      part.ids = new RowId(BUFFERED);
      part.buffered = 0;
      part.next = part.node.start;
    }
    const flush = (part) => {
      gathered.write(part.next * 3, part.centers, part.buffered * 3);
      order.write(part.next, part.ids, part.buffered);
      part.next += part.buffered;
      part.buffered = 0;
    };
    positions.consume((values, rows, base) => {
      where.consume(base, which, rows);
      for (let i = 0; i < rows; i++) {
        const part = parts[which[i]];
        const place = part.buffered++;
        part.centers[place * 3] = values[i * 3];
        part.centers[place * 3 + 1] = values[i * 3 + 1];
        part.centers[place * 3 + 2] = values[i * 3 + 2];
        part.ids[place] = base + i;
        if (part.buffered === BUFFERED) flush(part);
      }
      advance(rows);
    });
    const nodes = [];
    for (const part of parts) {
      if (!part.node) continue;
      flush(part);
      nodes.push(part.node);
    }
    nodes.sort((a, b) => a.start - b.start);
    where.dispose();
    where = undefined;
    return nodes;
  }

  try {
    const nodes = await gatherParts();
    const cursors = [...starts];
    // Splits the parts from `first` up to `last`, `rows` rows, in memory. A
    // function of its own: its arrays are gone once it returns, before the
    // cache takes their memory below.
    const splitParts = async (first, last, rows) => {
      const { start } = nodes[first];
      const pages = (stride) =>
        Math.ceil((rows * stride) / PAGE_BYTES) * PAGE_BYTES;
      const shared = pages(12) + pages(4) + pages(RowId.BYTES_PER_ELEMENT);
      const scratch = scratchBytes(rows);
      // Larger disjoint nodes can each hold a cut on the main thread while
      // their stretches are scanned. At most one chooses a split at a time.
      const cuts = Math.floor(rows / (Math.max(STRETCH, limit) + 1));
      const threads = clusterers(
        workspace,
        HEAP_MB * 1024 ** 2 + scratch,
        shared + cuts * CUT_BYTES + (cuts ? CUT_SUFFIX_BYTES : 0),
        Math.ceil(rows / limit),
        shared + scratch,
      );
      const centers = new Float32Array(sharedBuffer(rows * 12), 0, rows * 3);
      const local = new Uint32Array(sharedBuffer(rows * 4), 0, rows);
      const ids = new RowId(
        sharedBuffer(rows * RowId.BYTES_PER_ELEMENT),
        0,
        rows,
      );
      if (gathered) {
        gathered.consume(start * 3, centers, rows * 3);
        order.consume(start, ids, rows);
      } else {
        // A single batch is already in input order.
        for (const [i, level] of levels.entries()) {
          const target = centers.subarray(starts[i] * 3);
          level.centers.consume(0, target, level.length * 3);
          level.centers.dispose();
          advance(level.length);
        }
      }
      for (let i = 0; i < rows; i++) local[i] = i;
      if (!gathered) ids.set(local);
      const roots = nodes.slice(first, last);
      for (const node of roots) node.start -= start;
      await splitShared(
        workspace,
        centers,
        local,
        ids,
        roots,
        limit,
        starts,
        threads,
        advance,
      );
      // Parts arranged by level hold each row's place in its level.
      const stack = roots.reverse();
      while (stack.length) {
        const node = stack.pop();
        if (node.children) {
          stack.push(node.children[1], node.children[0]);
          continue;
        }
        let at = node.start;
        leafCount++;
        for (const level in node.lods) {
          const count = node.lods[level];
          leavesByLevel[level].push(node);
          arranged.write(cursors[level], local.subarray(at, at + count), count);
          at += count;
          cursors[level] += count;
        }
      }
    };
    for (let first = 0; first < nodes.length; ) {
      let last = first + 1;
      let rows = nodes[first].count;
      for (; last < nodes.length; last++) {
        if (rows + nodes[last].count > fit) break;
        rows += nodes[last].count;
      }
      await splitParts(first, last, rows);
      first = last;
    }
    progress.finish();
    // The centers and the threads are gone: the cache may take their memory.
    workspace.settle();
    workspace.expect(0);
    return { root, leavesByLevel, leafCount, order: arranged };
  } catch (error) {
    arranged.dispose();
    throw error;
  } finally {
    where?.dispose();
    order?.dispose();
    gathered?.dispose();
  }
}

if (!isMainThread && (workerData?.scanner || workerData?.splitter)) {
  const { scanner, centers, order, ids, starts, cancelled } = workerData;
  const check = () => {
    if (cancelled && Atomics.load(cancelled, 0))
      throw new Error("Conversion cancelled");
  };
  const handler = scanner
    ? new Scanner(check)
    : new Splitter(centers, order, ids, starts, check);
  parentPort.on("message", (job) => {
    const result = handler.handle(job);
    const transfer = [];
    if (job.kind === "bins") {
      for (const { sizes, mins, maxs } of scanner ? result : [result])
        transfer.push(sizes.buffer, mins.buffer, maxs.buffer);
    }
    parentPort.postMessage(result, transfer);
  });
}
