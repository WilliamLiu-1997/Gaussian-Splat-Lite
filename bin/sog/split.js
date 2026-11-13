import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { WorkerGroup, clusterers } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import { IndexArray, PagedArray, sharedBuffer } from "../rad/storage.js";
import { sortMorton } from "./morton.js";
import { BATCH, Positions } from "./positions.js";
import { Cut, binRange, boundsOf, partRange, splitRange } from "./spatial.js";

// Bytes in memory of a row while its part is split: its center, its place
// in the order and its row.
const GATHERED_BYTES = 20;
// The share of the room that the parts split at a time may take.
const SHARE = 0.5;
// Rows buffered for each part while its centers are put side by side.
const BUFFERED = 4096;
// Rows of a large node that a thread takes at a time.
const STRETCH = 1 << 20;
// Rows of a batch that a thread takes of a pass over the centers, and the
// bytes of a row in it: its center and its part.
const SCAN = 1 << 18;
const SCANNED_BYTES = 20;
// The most a splitting thread's heap may grow to, in MiB, and what
// clusterers() counts for a thread besides: 12 MiB before any work and a
// young generation of 8 MiB, measured. The heap holds little but the nodes.
const HEAP_MB = 32;
// The most rows of an array in a WebAssembly memory of 4 GiB.
const MOST = Math.floor(0xffff0000 / 12);

// Gives `node` its two children at `middle`, and with a quota, theirs in
// proportion to their counts.
function divide(node, middle) {
  const { start, count, quota } = node;
  const left = middle - start;
  const right = count - left;
  node.children = [
    { start, count: left },
    { start: middle, count: right },
  ];
  if (quota === undefined) return;
  const a =
    quota === 1
      ? 1
      : Math.max(
          1,
          quota - right,
          Math.min(left, quota - 1, Math.round((quota * left) / count)),
        );
  node.children[0].quota = a;
  node.children[1].quota = Math.max(1, quota - a);
}

// Centers in memory, read as splitRange() reads rows. Polls for
// cancellation as the paged arrays do.
class Centers {
  constructor(values, check) {
    this.values = values;
    this.check = check;
    this.reads = 0;
  }

  read(index, record) {
    if ((++this.reads & 0xfffff) === 0) this.check();
    const at = index * 3;
    record[0] = this.values[at];
    record[1] = this.values[at + 1];
    record[2] = this.values[at + 2];
    return record;
  }
}

// The order of rows in memory, with what splitRange() uses of an
// IndexArray.
class Order {
  constructor(values) {
    this.values = values;
  }

  get(index) {
    return this.values[index];
  }

  set(index, value) {
    this.values[index] = value;
  }

  sort(start, count) {
    this.values.subarray(start, start + count).sort();
  }
}

// Splits nodes of the centers in the order, both in shared memory, as is
// `ids`, the row of each center. Nodes own separate ranges of the order, so
// threads split them at once; so do the stretches of a large node's rows,
// whose boxes and bins add up to the node's.
class Splitter {
  constructor(centers, order, ids, check) {
    this.rows = new Centers(centers, check);
    this.order = new Order(order);
    this.ids = ids;
    this.check = check;
    // A part's levels, its rows and centers level by level, and the keys
    // that sort a level's rows; see arrange(). They are kept from part to
    // part, so that a thread takes no more than the largest part needs.
    this.levels = new Uint32Array(0);
    this.indices = new Uint32Array(0);
    this.positions = new Float32Array(0);
    this.keys = new BigUint64Array(0);
  }

  // Splits `node` into parts of at most `limit` rows and returns it. With
  // `bounds`, every node gets the box of its centers, and the parts are
  // arranged by the levels that start at the rows `starts`; without, the
  // parts are sorted by row.
  tree({ node, limit, bounds, starts }) {
    const { rows, order } = this;
    const pending = [node];
    while (pending.length) {
      this.check();
      const next = pending.pop();
      const { start, count } = next;
      if (bounds) next.bound = boundsOf(rows, order, start, count);
      if (count <= limit) {
        if (bounds) this.arrange(next, starts);
        else order.sort(start, count);
        continue;
      }
      divide(next, splitRange(rows, order, start, count, next.bound));
      pending.push(...next.children);
    }
    return node;
  }

  // Puts the rows of the part `node` side by side level by level, each
  // level's in the Morton order of their centers, as a chunk holds them.
  // The order then holds each row's place in its level, and `lods` of the
  // node where each level's rows lie after the node's start.
  arrange(node, starts) {
    const { start, count } = node;
    const { ids } = this;
    const order = this.order.values;
    const centers = this.rows.values;
    if (count > this.levels.length) {
      this.levels = new Uint32Array(count);
      this.indices = new Uint32Array(count);
      this.positions = new Float32Array(count * 3);
      this.keys = new BigUint64Array(count);
    }
    const { levels, indices, positions, keys } = this;
    const counts = new Uint32Array(starts.length);
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
      counts[low]++;
    }
    const firsts = new Uint32Array(starts.length);
    for (let level = 1; level < starts.length; level++)
      firsts[level] = firsts[level - 1] + counts[level - 1];
    for (let i = 0; i < count; i++) {
      const id = order[start + i];
      const level = levels[i];
      const at = firsts[level]++;
      indices[at] = ids[id] - starts[level];
      for (let d = 0; d < 3; d++) positions[at * 3 + d] = centers[id * 3 + d];
    }
    node.lods = {};
    for (let level = 0, first = 0; level < starts.length; level++) {
      const size = counts[level];
      if (!size) continue;
      sortMorton(
        indices.subarray(first, first + size),
        positions.subarray(first * 3, (first + size) * 3),
        keys,
        order,
        start + first,
      );
      node.lods[level] = { offset: first, count: size };
      first += size;
    }
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
  job,
  threads,
  advance,
) {
  const check = () => workspace.check();
  const group = new WorkerGroup(
    new URL(import.meta.url),
    threads,
    { splitter: true, centers, order, ids, cancelled: workspace.cancelled },
    new Splitter(centers, order, ids, check),
    "Splitting",
    HEAP_MB,
  );
  const { limit, bounds, starts } = job;
  // A node of more than `grain` rows is cut here, with a stretch of its rows
  // for each thread at a time; smaller nodes go whole to a thread. On this
  // thread alone, a root is split to the end at once.
  const grain = threads
    ? Math.max(limit, STRETCH, Math.ceil(order.length / threads / 4))
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
          const tree = { kind: "tree", node, limit, bounds, starts };
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
        if (bounds) node.bound = bound;
        const cut = new Cut(bound);
        for (const bins of await each({ kind: "bins", bound })) cut.merge(bins);
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
        await Promise.all(node.children.map(split));
      };
      Promise.all(roots.map(split)).then(resolve, reject);
    });
  } finally {
    await group.close();
  }
}

// Makes room for the threads that split `rows` rows held in `bytes` of
// memory, at most `most`, and returns how many there are.
const splitters = (workspace, rows, bytes, { limit, most }) =>
  clusterers(
    workspace,
    HEAP_MB * 1024 ** 2,
    bytes,
    Math.min(most, Math.ceil(rows / limit)),
  );

// Adds `delta` to the starts of `node` and the nodes below it.
function shift(node, delta) {
  node.start += delta;
  if (node.children) for (const child of node.children) shift(child, delta);
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

// Passes over a batch of centers, four values a row, with the part of each
// row in `which`. Threads take batches at once: boxes, bins and counts of
// the batches add up to those of all rows.
class Scanner {
  constructor(check) {
    this.check = check;
  }

  // The rows and the box of the batch.
  box({ values, rows }) {
    const part = newPart();
    for (let i = 0; i < rows; i++) tally(part, values, i * 4);
    return part;
  }

  // The bins of the batch's rows of each part in `cuts`, with the box of
  // the part's centers.
  bins({ values, which, rows, cuts }) {
    const of = [];
    for (const { part, bound } of cuts) of[part] = new Cut(bound);
    for (let i = 0; i < rows; i++) {
      const cut = of[which[i]];
      if (cut) cut.add(values, i * 4);
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
        cut.axis < 0 ? cut.half-- > 0 : values[i * 4 + cut.axis] < cut.value;
      const side = before ? 0 : 1;
      which[i] = cut.first + side;
      tally(cut.parts[side], values, i * 4);
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
async function cutLarge(workspace, positions, where, parts, job, fit, advance) {
  const { length } = positions;
  const check = () => workspace.check();
  const threads = clusterers(
    workspace,
    HEAP_MB * 1024 ** 2 + SCAN * SCANNED_BYTES,
    SCAN * SCANNED_BYTES,
    Math.min(job.most, Math.ceil(length / SCAN)),
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
    const buffers = group.threads.map(() => sharedBuffer(SCAN * SCANNED_BYTES));
    // Runs `scan` over all centers, a batch for each thread at a time, or
    // `ordered`, batch after batch; `taken` gets what each batch returns.
    const pass = async (scan, taken, ordered = false) => {
      let base = 0;
      const batches = async (worker, thread) => {
        const values = new Float32Array(buffers[thread], 0, SCAN * 4);
        const which = new Uint32Array(buffers[thread], SCAN * 16, SCAN);
        while (base < length) {
          const from = base;
          const rows = Math.min(SCAN, length - from);
          base += rows;
          positions.read(from, values, rows);
          if (scan.cuts) where.read(from, which, rows);
          const batch = { ...scan, values, which, rows };
          taken(await group.request(worker, batch), from, which, rows);
          advance(rows);
        }
      };
      if (ordered) await batches(group.threads[0], 0);
      else await Promise.all(group.threads.map(batches));
    };
    await pass({ kind: "box" }, (batch) => add(parts[0], batch));
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
        if (job.bounds) node.bound = part.box;
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

// Divides `root`, the `length` splats of `levels` one level after another,
// into parts of at most `job.limit`; see Splitter.tree(). Returns the order
// of rows with each part's side by side: with `job.starts`, as
// Splitter.arrange() leaves them.
//
// Rows are split in memory, on at most `job.most` worker threads whose
// number follows the memory budget as for SH clustering. More rows than fit
// in memory are first cut into parts that fit, see cutLarge(). Every part's
// centers and rows are then put side by side, and the parts are split, as
// many at a time as fit.
async function split(workspace, levels, length, root, job) {
  workspace.settle();
  const fit = Math.max(
    job.limit,
    Math.min(MOST, Math.floor((workspace.room * SHARE) / GATHERED_BYTES)),
  );
  // Progress counts passes over the rows: one each to read their centers,
  // to put the parts side by side and to split them. Cutting what does not
  // fit takes a pass for the box and two a level; it is counted with twice
  // the levels that even halves take, and never beyond.
  const cutting =
    length > fit ? length * (1 + 4 * Math.ceil(Math.log2(length / fit))) : 0;
  const progress = new Progress(job.label, 3 * length + cutting);
  let done = 0;
  const advance = (rows, most = Number.POSITIVE_INFINITY) => {
    done = Math.min(done + rows, most);
    progress.update(done);
  };
  const order = new IndexArray(workspace);
  order.length = length;
  let positions;
  let where;
  let gathered;
  try {
    positions = new Positions(workspace, levels, length, advance);
    // Every row starts in the root's part, 0.
    where = new PagedArray(workspace, Uint32Array, length);
    const parts = [newPart()];
    parts[0].node = root;
    if (length > fit)
      await cutLarge(workspace, positions, where, parts, job, fit, (rows) =>
        advance(rows, length + cutting),
      );
    done = length + cutting;
    const which = new Uint32Array(BATCH);
    // Every part's centers go to its place in `gathered`, and its rows to
    // its place in the order, through a small buffer for each part.
    gathered = new PagedArray(workspace, Float32Array, length * 3);
    for (const part of parts) {
      if (!part.node) continue;
      part.centers = new Float32Array(BUFFERED * 3);
      part.ids = new Uint32Array(BUFFERED);
      part.buffered = 0;
      part.next = part.node.start;
    }
    const flush = (part) => {
      gathered.write(part.next * 3, part.centers, part.buffered * 3);
      order.write(part.next, part.ids, part.buffered);
      part.next += part.buffered;
      part.buffered = 0;
    };
    positions.scan((values, rows, base) => {
      if (parts.length > 1) where.read(base, which, rows);
      for (let i = 0; i < rows; i++) {
        const part = parts[which[i]];
        const place = part.buffered++;
        part.centers[place * 3] = values[i * 4];
        part.centers[place * 3 + 1] = values[i * 4 + 1];
        part.centers[place * 3 + 2] = values[i * 4 + 2];
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
    positions.dispose();
    positions = undefined;
    where.dispose();
    where = undefined;
    // Splits the parts from `first` up to `last`, `rows` rows, in memory. A
    // function of its own: its arrays are gone once it returns, before the
    // cache takes their memory below.
    const splitParts = async (first, last, rows) => {
      const { start } = nodes[first];
      const threads = splitters(workspace, rows, rows * GATHERED_BYTES, job);
      const centers = new Float32Array(sharedBuffer(rows * 12), 0, rows * 3);
      const local = new Uint32Array(sharedBuffer(rows * 4), 0, rows);
      const ids = new Uint32Array(sharedBuffer(rows * 4), 0, rows);
      gathered.read(start * 3, centers, rows * 3);
      order.read(start, ids, rows);
      for (let i = 0; i < rows; i++) local[i] = i;
      // The parts as nodes of the rows in memory, then back in their places.
      const roots = [];
      for (let i = first; i < last; i++)
        roots.push({ ...nodes[i], start: nodes[i].start - start });
      await splitShared(
        workspace,
        centers,
        local,
        ids,
        roots,
        job,
        threads,
        advance,
      );
      roots.forEach((node, i) => {
        shift(node, start);
        Object.assign(nodes[first + i], node);
      });
      // Parts that are arranged by level hold their rows already.
      if (!job.starts) for (let i = 0; i < rows; i++) local[i] = ids[local[i]];
      order.write(start, local, rows);
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
    return order;
  } catch (error) {
    order.dispose();
    throw error;
  } finally {
    positions?.dispose();
    where?.dispose();
    gathered?.dispose();
  }
}

// Divides a level into working blocks of at most `limit` splats, each with
// its quota and sorted by row, on at most `most` threads.
export const splitBlocks = (source, root, limit, most) =>
  split(source.workspace, [source], source.length, root, {
    limit,
    most,
    bounds: false,
    label: "Dividing voxel blocks",
  });

// Divides all levels' splats into regions of at most `limit`, every node
// with the box of its centers, and arranges each region's rows by level.
export const splitRegions = (rows, root, limit) =>
  split(rows.workspace, rows.levels, rows.length, root, {
    limit,
    most: Number.POSITIVE_INFINITY,
    bounds: true,
    starts: rows.starts,
    label: "Partitioning regions",
  });

if (!isMainThread && workerData?.scanner) {
  const { cancelled } = workerData;
  const scanner = new Scanner(() => {
    if (cancelled && Atomics.load(cancelled, 0))
      throw new Error("Conversion cancelled");
  });
  parentPort.on("message", (batch) =>
    parentPort.postMessage(scanner.handle(batch)),
  );
}

if (!isMainThread && workerData?.splitter) {
  const { centers, order, ids, cancelled } = workerData;
  const splitter = new Splitter(centers, order, ids, () => {
    if (cancelled && Atomics.load(cancelled, 0))
      throw new Error("Conversion cancelled");
  });
  parentPort.on("message", (job) =>
    parentPort.postMessage(splitter.handle(job)),
  );
}
