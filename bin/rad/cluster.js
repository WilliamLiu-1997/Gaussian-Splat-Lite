// SH codebook clustering adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { HALF } from "./math.js";
import { WorkerGroup, clusterers } from "./parallel.js";
import { Progress } from "./progress.js";
import { SH_DIMS } from "./splats.js";
import { PAGE_BYTES, PagedArray } from "./storage.js";

// Maximum entries for each retained SH degree, excluding the base color.
const MAX_CODES = [0, 262144, 262144, 262144];
// Training reads SAMPLE_SHARE of the splats, and at least SAMPLES_PER_CODE
// per entry; larger models train on a sample by weight, and only the final
// assignment reads all. Entries start at evenly spaced training splats.
// With codebooks shrunk to keep 16 per entry at 5%, renders of Elevator and
// JunkShop came 5–14% closer to the uncompressed SH at 10% than at 5%; on
// C-NorthSouth (111M splats after LOD) clustering took about 185 s, not 170.
// On Elevator (3.9M splats after LOD), 64 per entry, here all splats, came
// 5.8% closer than 16 at full detail, with 41% fewer pixels off by more than
// 32 levels in LOD views, in 18 s instead of 6 s.
const SAMPLES_PER_CODE = 64;
const SAMPLE_SHARE = 0.1;
// Splats per job of a thread, each a call of the kernel. A search by group
// takes the splats of a group four at a time, so a call needs several for
// each group.
const JOB = 4096;
// Jobs per thread that are under way, at most: a thread labels one at a
// time, as many wait for the jobs before them, and as many are added to the
// entries' sums.
const WINDOW = 3;
// Codes per block of the kernel's layout.
const BLOCK = 8;
// With at least GROUPED entries, each pass searches only part of them: the
// entries are clustered into groups, and each splat searches the entries of
// the groups with the nearest centers, TRAIN_PROBES of them in iterations
// and FINAL_PROBES in the final pass. There is a group for every
// GROUP_ENTRIES[0] entries up to GROUPS[0] groups, and more, up to
// GROUPS[1], only once each holds GROUP_ENTRIES[1]. Grouping takes
// GROUP_STEPS steps from evenly spaced entries, then one from the last
// pass's groups. On Elevator this fit the entries better than comparing all
// of them, as with few probes entries stay near their groups, in a
// twentieth of the time; the final pass gave 99% of splats their nearest
// entry. For 262144 entries, 2048 groups ended as close as 512 with half
// the final pass; for 4096 to 16384 entries, groups ended 1% closer than
// comparing all, in a fifth to a tenth of the time.
const GROUPED = 4096;
const GROUPS = [512, 2048];
const GROUP_ENTRIES = [32, 128];
const TRAIN_PROBES = 4;
const FINAL_PROBES = 16;
const GROUP_STEPS = 4;
// An iteration finds each splat's groups anew only every SEARCH_EVERY-th
// time, and whenever a group is empty; the others search the groups found
// last. Few splats change their entry after the first iterations: on
// Elevator's SOG chunks this halved the iterations' time and ended as close.
const SEARCH_EVERY = 5;

// The groups that `count` entries are searched by, none for few entries.
const groupsOf = (count) =>
  count < GROUPED
    ? 0
    : Math.min(
        GROUPS[1],
        Math.max(
          Math.floor(count / GROUP_ENTRIES[1]),
          Math.min(GROUPS[0], Math.floor(count / GROUP_ENTRIES[0])),
        ),
      );

let kernel;
// The compiled nearest-code kernel, loaded before converting.
export function codebookKernel() {
  if (kernel) return kernel;
  let bytes;
  try {
    bytes = readFileSync(new URL("../decoder/cluster.wasm", import.meta.url));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "SH clustering module not found; build it with npm run build:wasm:lod",
    );
  }
  kernel = new WebAssembly.Module(bytes);
  return kernel;
}

// Bytes of scratch memory that the kernel's search by `groups` groups needs.
const scratchBytes = (module, dims, groups) =>
  groups
    ? new WebAssembly.Instance(module, {}).exports.probed_scratch(
        JOB,
        dims,
        groups,
        FINAL_PROBES,
      )
    : 0;

// Bytes of a kernel instance's memory for `blocks` blocks of codes, with the
// module's own 1 MiB, and for the groups of a search by group, if any: each
// group may add a block, a u32 slot-to-code map, and `scratch` bytes for
// the search, and each splat of a job has its groups.
function kernelBytes(dims, blocks, groups, scratch) {
  const slots = (blocks + groups) * BLOCK;
  return (
    (slots + groups) * (dims + 1) * 4 +
    (groups ? slots * 4 + JOB * FINAL_PROBES * 4 : 0) +
    groups * 8 +
    scratch +
    JOB * (dims * 4 + 64 + 4) +
    1024 ** 2
  );
}

// Bytes of the arrays of the thread that clusters `count` entries: the
// entries with their sums and their layout for the kernel; for groups, the
// entries as points with their groups and the table that finds equal ones,
// the groups' means and sums, and the grouped layout with its order.
function ownBytes(dims, count, blocks, groups) {
  const slots = (blocks + groups) * BLOCK;
  return (
    count * (dims * 16 + 8) +
    (groups
      ? count * (dims * 4 + 2 + 17) +
        groups * dims * 16 +
        (slots + groups) * (dims + 1) * 4 +
        slots * 4
      : blocks * BLOCK * (dims + 1) * 4)
  );
}

// The buffers of `slots` jobs of up to `size` splats in the shared memory
// `buffer`: each job's weights, rows of `dims` values, labels and `probes`
// groups a splat. Every thread reads and writes a job's splats where they
// are, so jobs travel as the numbers of their slots.
function jobBuffers({ buffer, slots, size, dims, halves, wide, probes }) {
  const Type = halves ? Uint16Array : Float32Array;
  const LabelArray = wide ? Uint32Array : Uint16Array;
  let offset = 0;
  const take = (Type, items) => {
    const values = new Type(buffer, offset, items);
    offset += items * Type.BYTES_PER_ELEMENT;
    return values;
  };
  return Array.from({ length: slots }, (_, slot) => ({
    slot,
    weights: take(Float64Array, size),
    bits: take(Type, size * dims),
    labels: take(LabelArray, size),
    picks: take(Uint16Array, size * probes),
  }));
}

// A thread's instance of the kernel, with the codes in blocks of 8, their
// squared lengths, and room for a job's points, the kernel's state and the
// labels; with `groups`, also room for the grouped codes, the groups'
// centers and table, each point's groups, and the search's scratch memory.
// `entries` are the jobs' buffers and the entries' sums and total weights,
// all in shared memory.
class Nearest {
  constructor(module, dims, blocks, groups, entries) {
    this.jobs = jobBuffers(entries.jobs);
    this.sums = entries.sums;
    this.totals = entries.totals;
    const { exports } = new WebAssembly.Instance(module, {});
    const memory = exports.memory;
    const align = (bytes) => Math.ceil(bytes / 16) * 16;
    const slots = (blocks + groups) * BLOCK;
    const centers = Math.ceil(groups / BLOCK) * BLOCK;
    this.exports = exports;
    this.dims = dims;
    this.blocks = blocks;
    this.groups = 0;
    this.codes = align(memory.buffer.byteLength);
    this.norms = this.codes + slots * dims * 4;
    this.centers = align(this.norms + slots * 4);
    this.centerNorms = this.centers + centers * dims * 4;
    this.starts = align(this.centerNorms + centers * 4);
    this.sizes = this.starts + groups * 4;
    this.points = align(this.sizes + groups * 4);
    this.state = align(this.points + JOB * dims * 4);
    this.labels = this.state + (JOB / 4) * 256;
    this.picks = align(this.labels + JOB * 4);
    this.scratch = align(this.picks + (groups ? JOB * FINAL_PROBES * 4 : 0));
    const end =
      this.scratch +
      (groups ? exports.probed_scratch(JOB, dims, groups, FINAL_PROBES) : 0);
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    const { buffer } = memory;
    this.codeView = new Float32Array(buffer, this.codes, slots * dims);
    this.normView = new Float32Array(buffer, this.norms, slots);
    this.centerView = new Float32Array(buffer, this.centers, centers * dims);
    this.centerNormView = new Float32Array(buffer, this.centerNorms, centers);
    this.startView = new Uint32Array(buffer, this.starts, groups);
    this.sizeView = new Uint32Array(buffer, this.sizes, groups);
    this.pointView = new Float32Array(buffer, this.points, JOB * dims);
    this.labelView = new Uint32Array(buffer, this.labels, JOB);
    this.pickView = new Uint32Array(
      buffer,
      this.picks,
      groups ? JOB * FINAL_PROBES : 0,
    );
    this.center = new Float64Array(dims);
    // Whether the search of all codes and the search by group have run.
    this.warm = false;
    this.warmGroups = false;
  }

  handle(message) {
    if (message.type === "codes") {
      this.codeView.set(message.codes);
      this.normView.set(message.norms);
      this.center.set(message.center);
      // A first small call makes the engine optimize the kernel before the
      // next: a call that runs long stays unoptimized to its end.
      if (!this.warm) this.call(4);
      this.warm = true;
      return true;
    }
    if (message.type === "groups") {
      // From now on, codes are searched by group; `order` maps their
      // positions to their indices.
      this.codeView.set(message.codes);
      this.normView.set(message.norms);
      this.centerView.set(message.centers);
      this.centerNormView.set(message.centerNorms);
      this.startView.set(message.starts);
      this.sizeView.set(message.sizes);
      this.center.set(message.center);
      this.order = message.order;
      this.probes = message.probes;
      this.groups = message.starts.length;
      if (!this.warmGroups) this.call(4);
      this.warmGroups = true;
      return true;
    }
    if (message.type === "group") {
      // For grouping, codes are the points: labels `count` of them from
      // `first` with their nearest centers, in shared memory.
      const { points, centers, norms, labels, first, count } = message;
      const { dims, pointView, labelView } = this;
      this.centerView.set(centers);
      this.centerNormView.set(norms);
      for (let start = first; start < first + count; start += JOB) {
        const size = Math.min(JOB, first + count - start);
        const rows = Math.ceil(size / 4) * 4;
        pointView.set(points.subarray(start * dims, (start + size) * dims));
        for (let i = size; i < rows; i++)
          pointView.copyWithin(i * dims, (size - 1) * dims, size * dims);
        this.exports.nearest(
          this.points,
          rows,
          dims,
          this.centers,
          this.centerNorms,
          centers.length / (BLOCK * dims),
          this.state,
          this.labels,
        );
        labels.set(labelView.subarray(0, size), start);
      }
      return true;
    }
    if (message.type === "sum") {
      // Adds the splats of the jobs in `slots` to the sums of the entries
      // from `from` up to `to`, in the splats' order.
      const { slots, counts, from, to } = message;
      const { dims, sums, totals } = this;
      for (let j = 0; j < slots.length; j++) {
        const { bits, labels, weights } = this.jobs[slots[j]];
        for (let i = 0; i < counts[j]; i++) {
          const c = labels[i];
          if (c < from || c >= to) continue;
          const w = weights[i];
          for (let d = 0; d < dims; d++)
            sums[c * dims + d] += w * valueAt(bits, i * dims + d);
          totals[c] += w;
        }
      }
      return true;
    }
    // A job: labels the first `count` splats of its slot. With `pick`,
    // their groups are written to the slot's `picks`, or with `reuse` those
    // that it holds are searched.
    const { slot, count, pick, reuse } = message;
    const { bits, labels, picks } = this.jobs[slot];
    const { dims, center, pointView, labelView, pickView, order, probes } =
      this;
    // Points relative to the center; the last fills the final group of 4.
    const rows = Math.ceil(count / 4) * 4;
    for (let i = 0; i < rows; i++) {
      const row = Math.min(i, count - 1) * dims;
      for (let d = 0; d < dims; d++)
        pointView[i * dims + d] = valueAt(bits, row + d) - center[d];
    }
    if (reuse) {
      pickView.set(picks.subarray(0, count * probes));
      for (let i = count; i < rows; i++)
        pickView.copyWithin(i * probes, (count - 1) * probes, count * probes);
    }
    this.call(rows, reuse);
    if (!this.groups) labels.set(labelView.subarray(0, count));
    else for (let i = 0; i < count; i++) labels[i] = order[labelView[i]];
    if (pick && !reuse) picks.set(pickView.subarray(0, count * probes));
    return true;
  }

  call(rows, reuse = false) {
    if (!this.groups) {
      this.exports.nearest(
        this.points,
        rows,
        this.dims,
        this.codes,
        this.norms,
        this.blocks,
        this.state,
        this.labels,
      );
      return;
    }
    this.exports.probed(
      this.points,
      rows,
      this.dims,
      this.centers,
      this.centerNorms,
      this.groups,
      this.codes,
      this.norms,
      this.starts,
      this.sizes,
      this.probes,
      this.picks,
      reuse ? 1 : 0,
      this.scratch,
      this.labels,
    );
  }
}

if (!isMainThread && workerData?.codebook) {
  const { module, dims, blocks, groups, entries } = workerData;
  const nearest = new Nearest(module, dims, blocks, groups, entries);
  parentPort.on("message", (message) =>
    parentPort.postMessage(nearest.handle(message)),
  );
}

// Spreads nearest-code jobs over worker threads, or runs them on this thread
// without any.
class Assigner extends WorkerGroup {
  constructor(module, dims, blocks, groups, entries, count) {
    super(
      new URL(import.meta.url),
      count,
      { codebook: true, module, dims, blocks, groups, entries },
      count ? undefined : new Nearest(module, dims, blocks, groups, entries),
      "SH clustering",
    );
    this.entries = entries.totals.length;
  }

  // Gives every thread the codes, or their groups, in a message of `type`;
  // workers copy them from shared memory.
  use(type, layout) {
    return this.broadcast({ type, ...layout });
  }

  // Labels codes with their nearest group centers for grouping, the codes
  // spread evenly over the threads.
  group(work) {
    const { threads } = this;
    const each = Math.ceil(work.count / threads.length);
    return Promise.all(
      threads.map((worker, t) => {
        const first = Math.min(t * each, work.count);
        const count = Math.min(each, work.count - first);
        return this.request(worker, { type: "group", ...work, first, count });
      }),
    );
  }

  // Runs `jobs` jobs, each from `read(index)`: a thread labels its splats,
  // and `consume` gets it in job order. With `sum`, the threads then add
  // the jobs' splats to the entries' sums, a job for each thread at a time:
  // every thread adds the splats of its share of the entries, so that an
  // entry adds its splats in their order with any number of threads.
  // `release` gets each job once its slot is free. No more than WINDOW jobs
  // per thread are under way: a slow job holds back the next instead of
  // letting finished ones pile up. A thread labels one job at a time, as a
  // job takes far longer than its messages, so a slow thread holds back
  // only that one. After a failure no more start.
  run(jobs, read, consume, release, sum) {
    const { threads, entries } = this;
    const busy = threads.map(() => false);
    const results = new Map();
    // The jobs read, consumed and released, and those consumed that wait to
    // be added.
    let next = 0;
    let consumed = 0;
    let released = 0;
    let waiting = [];
    let stopped = false;
    return new Promise((resolve, reject) => {
      const stop = (error) => {
        if (!stopped) reject(error);
        stopped = true;
      };
      const free = (job) => {
        released++;
        release(job);
      };
      const add = () => {
        const added = waiting;
        waiting = [];
        const message = {
          type: "sum",
          slots: added.map((job) => job.slot),
          counts: added.map((job) => job.count),
        };
        Promise.all(
          threads.map((worker, t) =>
            this.request(worker, {
              ...message,
              from: Math.floor((t * entries) / threads.length),
              to: Math.floor(((t + 1) * entries) / threads.length),
            }),
          ),
        ).then(() => {
          added.forEach(free);
          pump();
        }, stop);
      };
      const pump = () => {
        if (stopped) return;
        try {
          for (; results.has(consumed); consumed++) {
            const job = results.get(consumed);
            results.delete(consumed);
            consume(job);
            if (!sum) free(job);
            else if (waiting.push(job) === threads.length) add();
          }
          if (consumed === jobs && waiting.length) add();
          if (released === jobs) {
            stopped = true;
            resolve();
            return;
          }
          for (let t = 0; t < threads.length && next < jobs; t++) {
            if (busy[t]) continue;
            if (next - released >= WINDOW * threads.length) break;
            const job = read(next++);
            const { slot, count, pick, reuse } = job;
            busy[t] = true;
            this.request(threads[t], { slot, count, pick, reuse }).then(() => {
              busy[t] = false;
              results.set(job.index, job);
              pump();
            }, stop);
          }
        } catch (error) {
          stop(error);
        }
      };
      pump();
    });
  }
}

// Rows that fit in the cache, allowing a partial page per column. Repeated
// scans cache this prefix and bypass the rest to avoid evicting it.
function fitting(bytes, row, columns) {
  const pages = Math.floor(bytes / PAGE_BYTES) - columns;
  return Math.max(0, Math.floor((pages * PAGE_BYTES) / row));
}

// Reads splats' SH as rows of half bits, the bands one after another, with
// their weights, area × opacity as merging weighs them.
class Rows {
  constructor(splats, dims) {
    this.Type = Uint16Array;
    this.splats = splats;
    this.dims = dims;
    this.length = splats.length;
    this.kept = Number.POSITIVE_INFINITY;
    this.column = new Uint16Array(JOB * SH_DIMS[SH_DIMS.length - 1]);
    this.records = new Float32Array(JOB * 16);
  }

  keep(bytes) {
    this.kept = fitting(bytes, this.dims * 2 + 64, this.splats.maxSh + 1);
  }

  read(base, count, bits, weights) {
    this.bands(base, count, bits);
    this.weigh(base, count, weights);
  }

  // The SH of `count` rows from `base`, as half bits, into `bits`.
  bands(base, count, bits) {
    const { splats, dims, column, kept } = this;
    let offset = 0;
    for (let band = 0; band < splats.maxSh; band++) {
      const size = SH_DIMS[band];
      splats.sh[band].scan(base * size, column, count * size, kept * size);
      for (let i = 0; i < count; i++)
        for (let d = 0; d < size; d++)
          bits[i * dims + offset + d] = column[i * size + d];
      offset += size;
    }
  }

  weigh(base, count, weights) {
    const records = this.splats.records.scan(
      base * 16,
      this.records,
      count * 16,
      this.kept * 16,
    );
    for (let i = 0; i < count; i++)
      weights[i] = records[i * 16 + 15] * records[i * 16 + 3];
  }
}

// What clustering uses of a PagedArray, in memory with room for `items`
// at first: for a thread that clusters without a workspace.
class MemoryArray {
  constructor(Type, items) {
    this.Type = Type;
    this.values = new Type(items);
    this.length = 0;
  }

  read(base, output, count = output.length) {
    output.set(this.values.subarray(base, base + count));
    return output;
  }

  scan(base, output, count) {
    return this.read(base, output, count);
  }

  write(base, values, count = values.length) {
    const end = base + count;
    if (end > this.values.length) {
      const grown = new this.Type(end + (end >> 3));
      grown.set(this.values.subarray(0, this.length));
      this.values = grown;
    }
    this.values.set(values.subarray(0, count), base);
    this.length = Math.max(this.length, end);
  }

  dispose() {
    this.values = undefined;
  }
}

// An array of about `items` items: paged in `workspace`, or in memory
// without one.
const array = (workspace, Type, items) =>
  workspace ? new PagedArray(workspace, Type) : new MemoryArray(Type, items);

// About `size` rows and weights sampled from other rows.
class Sample {
  constructor(workspace, dims, Type, size) {
    this.Type = Type;
    this.dims = dims;
    this.length = 0;
    this.kept = Number.POSITIVE_INFINITY;
    this.bits = array(workspace, Type, size * dims);
    this.weights = array(workspace, Float64Array, size);
  }

  keep(bytes) {
    this.kept = fitting(bytes, this.dims * this.Type.BYTES_PER_ELEMENT + 8, 2);
  }

  read(base, count, bits, weights) {
    this.bands(base, count, bits);
    this.weights.scan(base, weights, count, this.kept);
  }

  bands(base, count, bits) {
    const { dims, kept } = this;
    this.bits.scan(base * dims, bits, count * dims, kept * dims);
  }

  dispose() {
    this.bits.dispose();
    this.weights.dispose();
  }
}

// The histogram bucket of a weight: its top 16 bits in single precision,
// which order nonnegative values.
const float = new Float32Array(1);
const word = new Uint32Array(float.buffer);
function bucket(weight) {
  float[0] = weight;
  return word[0] >>> 16;
}

// Samples about `size` rows, each with probability min(1, weight / step):
// rows weighing at least the step stay with their weights, and the others
// are taken where the running total of their weights crosses each multiple
// of the step, weighing one step. The weighted means of the sample then
// estimate those of all rows, also when a few rows hold most of the weight,
// as coarse LOD splats do. The step that makes about `size` rows follows
// from a histogram of the weights. Without a workspace the sample stays in
// memory and no progress shows.
function sample(rows, size, workspace, label) {
  const { dims, length, Type } = rows;
  const result = new Sample(workspace, dims, Type, size);
  const bits = new Type(JOB * dims);
  const weights = new Float64Array(JOB);
  const picked = new Type(JOB * dims);
  const pickedWeights = new Float64Array(JOB);
  const progress =
    workspace && new Progress(`Sampling ${label} for clustering`, 2 * length);
  const counts = new Float64Array(32768);
  const sums = new Float64Array(32768);
  let total = 0;
  for (let base = 0; base < length; base += JOB) {
    const count = Math.min(JOB, length - base);
    rows.weigh(base, count, weights);
    for (let i = 0; i < count; i++) {
      const b = bucket(weights[i]);
      counts[b]++;
      sums[b] += weights[i];
      total += weights[i];
    }
    progress?.update(base + count);
  }
  // The expected count falls as the step grows; at total / size it is at
  // most `size`.
  const expected = (step) => {
    let sum = 0;
    for (let b = 0; b < counts.length; b++)
      if (counts[b])
        sum += sums[b] >= step * counts[b] ? counts[b] : sums[b] / step;
    return sum;
  };
  let low = 0;
  let step = total / size;
  for (let i = 0; i < 64; i++) {
    const middle = (low + step) / 2;
    if (expected(middle) > size) low = middle;
    else step = middle;
  }
  let light = 0;
  let next = step / 2;
  for (let base = 0; base < length; base += JOB) {
    const count = Math.min(JOB, length - base);
    rows.read(base, count, bits, weights);
    let n = 0;
    for (let i = 0; i < count; i++) {
      let w = weights[i];
      if (w < step) {
        light += w;
        if (light <= next) continue;
        next += step;
        w = step;
      }
      for (let d = 0; d < dims; d++) picked[n * dims + d] = bits[i * dims + d];
      pickedWeights[n++] = w;
    }
    result.bits.write(result.length * dims, picked, n * dims);
    result.weights.write(result.length, pickedWeights, n);
    result.length += n;
    progress?.update(length + base + count);
  }
  progress?.finish(`${result.length} of ${length} splats`);
  return result;
}

// Writes `codes` relative to `center` in the kernel's blocks of 8 and their
// squared lengths: position i holds code order[i]. Positions without a
// code, negative or past `order`, stay infinitely far.
function layout(codes, order, dims, center, blocks, norms) {
  norms.fill(Number.POSITIVE_INFINITY);
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    if (c < 0) continue;
    const block = Math.floor(i / BLOCK) * dims * BLOCK + (i % BLOCK);
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      const value = Math.fround(codes[c * dims + d] - center[d]);
      blocks[block + d * BLOCK] = value;
      norm += value * value;
    }
    norms[i] = norm;
  }
}

const shared = (Type, items) =>
  new Type(new SharedArrayBuffer(items * Type.BYTES_PER_ELEMENT));
const identity = (count) => Int32Array.from({ length: count }, (_, i) => i);

// Marks the codes that equal an earlier one in `marks`, with `table` to
// find them: room for two slots a code, a power of two.
function markRepeats(codes, count, dims, marks, table) {
  const words = new Uint32Array(
    codes.buffer,
    codes.byteOffset,
    codes.length * 2,
  );
  const size = dims * 2;
  const mask = table.length - 1;
  table.fill(-1);
  for (let c = 0; c < count; c++) {
    const first = c * size;
    let hash = 0;
    for (let w = first; w < first + size; w++)
      hash = Math.imul(hash, 0x01000193) ^ words[w];
    hash ^= hash >>> 15;
    marks[c] = 0;
    for (let slot = hash & mask; ; slot = (slot + 1) & mask) {
      const other = table[slot];
      if (other < 0) {
        table[slot] = c;
        break;
      }
      let w = 0;
      while (w < size && words[other * size + w] === words[first + w]) w++;
      if (w === size) {
        marks[c] = 1;
        break;
      }
    }
  }
}

// Groups codes for searches by group: k-means without weights, first from
// evenly spaced codes, then one step from the last groups, as codes move
// little between passes. Each step labels the codes with their nearest
// centers on the threads, then moves the centers to the means of their
// groups. Lays the codes out by group: the codes of each group fill whole
// blocks, and `order` maps positions to codes. Empty groups have infinitely
// far centers. Of codes that are equal, only the first is laid out: it wins
// every tie, so the others cannot be a splat's nearest. Splats whose SH are
// all alike, such as all zero, start as so many equal codes in one group,
// which every splat would otherwise compare.
class Grouper {
  constructor(count, dims, center, groups) {
    const blocks = Math.ceil(groups / BLOCK);
    this.count = count;
    this.dims = dims;
    this.center = center;
    this.groups = groups;
    // The codes relative to the center, as points, and their groups.
    this.points = shared(Float32Array, count * dims);
    this.labels = shared(Uint16Array, count);
    this.repeated = new Uint8Array(count);
    this.table = new Int32Array(2 ** Math.ceil(Math.log2(count * 2)));
    // Whether the last step left every center where it was: the same codes
    // then get the same groups again.
    this.still = false;
    this.means = undefined;
    this.sums = new Float64Array(groups * dims);
    this.sizes = new Uint32Array(groups);
    this.identity = identity(groups);
    // Each group adds at most a block of fillers.
    const slots = (Math.ceil(count / BLOCK) + groups) * BLOCK;
    // The layout that every pass sends the threads, made anew in place: the
    // threads read it only during the passes, between which it changes.
    this.layout = {
      codes: shared(Float32Array, slots * dims),
      norms: shared(Float32Array, slots),
      centers: shared(Float32Array, blocks * BLOCK * dims),
      centerNorms: shared(Float32Array, blocks * BLOCK),
      center,
    };
    this.order = shared(Int32Array, slots);
    this.starts = new Uint32Array(groups);
    this.blocks = new Uint32Array(groups);
    this.filled = new Uint32Array(groups);
    this.nonempty = new Int32Array(groups);
  }

  // Groups `codes` on the threads of `assigner` and returns their layout,
  // and whether every group has codes.
  async group(codes, assigner) {
    const { count, dims, center, groups, points, labels, sums, sizes } = this;
    const result = this.layout;
    for (let c = 0; c < count; c++)
      for (let d = 0; d < dims; d++)
        points[c * dims + d] = codes[c * dims + d] - center[d];
    const steps = this.means ? 1 : GROUP_STEPS;
    if (!this.means) {
      this.means = new Float64Array(groups * dims);
      for (let g = 0; g < groups; g++) {
        const c = Math.floor((g * count) / groups);
        this.means.set(codes.subarray(c * dims, (c + 1) * dims), g * dims);
      }
    }
    const { means } = this;
    for (let step = 0; step < steps; step++) {
      layout(
        means,
        this.identity,
        dims,
        center,
        result.centers,
        result.centerNorms,
      );
      await assigner.group({
        points,
        centers: result.centers,
        norms: result.centerNorms,
        labels,
        count,
      });
      sums.fill(0);
      sizes.fill(0);
      for (let c = 0; c < count; c++) {
        const g = labels[c];
        sizes[g]++;
        for (let d = 0; d < dims; d++)
          sums[g * dims + d] += codes[c * dims + d];
      }
      this.still = true;
      for (let g = 0; g < groups; g++)
        if (sizes[g])
          for (let d = 0; d < dims; d++) {
            const mean = sums[g * dims + d] / sizes[g];
            if (mean !== means[g * dims + d]) this.still = false;
            means[g * dims + d] = mean;
          }
    }
    // Equal codes have the same group; the first of them is searched.
    const { repeated } = this;
    markRepeats(codes, count, dims, repeated, this.table);
    sizes.fill(0);
    for (let c = 0; c < count; c++) if (!repeated[c]) sizes[labels[c]]++;
    const { starts, blocks, filled, nonempty } = this;
    let slots = 0;
    for (let g = 0; g < groups; g++) {
      starts[g] = slots / BLOCK;
      blocks[g] = Math.ceil(sizes[g] / BLOCK);
      slots += blocks[g] * BLOCK;
    }
    const order = this.order.subarray(0, slots).fill(-1);
    filled.fill(0);
    for (let c = 0; c < count; c++) {
      if (repeated[c]) continue;
      const g = labels[c];
      order[starts[g] * BLOCK + filled[g]++] = c;
    }
    layout(codes, order, dims, center, result.codes, result.norms);
    for (let g = 0; g < groups; g++) nonempty[g] = sizes[g] ? g : -1;
    layout(means, nonempty, dims, center, result.centers, result.centerNorms);
    return {
      full: !nonempty.includes(-1),
      layout: {
        ...result,
        starts,
        sizes: blocks,
        // Unfilled positions stay -1; their infinite norms exclude them.
        order,
      },
    };
  }
}

// Clusters SH into up to 262144 entries for SH1/SH2/SH3
// with weighted k-means as Spark does: entries start at evenly spaced splats,
// each of `iterations` moves them to the weighted mean of their splats, an
// entry without any stays, and a final pass labels each splat with its
// nearest entry. Weights are area × opacity. Training uses 10% of the
// splats, at least 64 per entry, sampled in proportion to their weights;
// with many entries, passes search only groups of them, and most iterations
// the groups that an earlier one found. Returns the entries, `count` rows
// of `dims` SH coefficients, and the labels.
export async function clusterSh(splats, iterations, module) {
  const { workspace, length } = splats;
  const dims = SH_DIMS.slice(0, splats.maxSh).reduce((a, b) => a + b, 0);
  const count = Math.min(length, MAX_CODES[splats.maxSh]);
  const rows = new Rows(splats, dims);
  // With room for an entry per splat, the codebook is the splats' SH.
  if (count === length) return everyRow(rows, workspace);
  return clusterRows(rows, workspace, iterations, module, count);
}

// The codebook with an entry for each of the rows, in their order: each
// row's own SH, so that its label is its index.
function everyRow(rows, workspace) {
  const { dims, length } = rows;
  // Half values are exact in single precision; nothing is summed.
  workspace.expect(length * dims * 4);
  const codes = new Float32Array(length * dims);
  const labels = new PagedArray(
    workspace,
    length <= 65536 ? Uint16Array : Uint32Array,
  );
  const bits = new Uint16Array(JOB * dims);
  const indices = new labels.Type(JOB);
  // The rows are read once: none needs to stay in the cache.
  rows.keep(0);
  const progress = new Progress("Collecting SH codebook", length);
  for (let base = 0; base < length; base += JOB) {
    const size = Math.min(JOB, length - base);
    rows.bands(base, size, bits);
    for (let i = 0; i < size * dims; i++)
      codes[base * dims + i] = HALF[bits[i]];
    for (let i = 0; i < size; i++) indices[i] = base + i;
    labels.write(base, indices, size);
    progress.update(base + size);
  }
  progress.finish(`${length} entries`);
  return { count: length, dims, codes, labels };
}

function valueAt(values, index) {
  return values.BYTES_PER_ELEMENT === 2 ? HALF[values[index]] : values[index];
}

// The rows that train `count` entries of `length` rows, at most.
const trainingRows = (length, count) =>
  Math.max(count * SAMPLES_PER_CODE, Math.round(length * SAMPLE_SHARE));

// Bytes at most that clusterRows() takes without a workspace for `length`
// rows of `dims` single-precision coefficients and `count` entries: the
// kernel, the jobs, the thread's arrays, each row's label and groups, and
// the sample if only a part of the rows trains the entries.
export function clusterBytes(module, length, dims, count) {
  const blocks = Math.ceil(count / BLOCK);
  const groups = groupsOf(count);
  const samples = trainingRows(length, count);
  return (
    kernelBytes(dims, blocks, groups, scratchBytes(module, dims, groups)) +
    WINDOW * JOB * (dims * 4 + 4 + 8 + TRAIN_PROBES * 2) +
    ownBytes(dims, count, blocks, groups) +
    length * 4 +
    Math.min(length, samples) * TRAIN_PROBES * 2 +
    (samples < length ? samples * (dims * 4 + 8) : 0)
  );
}

// Clusters the rows of `all` into `count` entries as clusterSh() describes.
// With a workspace, worker threads search, arrays are paged and progress
// shows. Without one this thread does everything in memory, as a thread
// that clusters one of many sets of rows does; clusterBytes() is its memory.
// Every job polls `check` for cancellation, also while it reads a sample.
export async function clusterRows(
  all,
  workspace,
  iterations,
  module,
  count,
  check = () => workspace.check(),
  label = "SH",
) {
  const { dims, length, Type } = all;
  const rowBytes = dims * Type.BYTES_PER_ELEMENT;
  const samples = trainingRows(length, count);
  const sampled = length > samples;
  const training = sampled ? sample(all, samples, workspace, label) : all;
  const LabelArray = count <= 65536 ? Uint16Array : Uint32Array;
  const labelBytes = LabelArray.BYTES_PER_ELEMENT;
  const labels = array(workspace, LabelArray, length);
  let picks;
  let assigner;
  try {
    const blocks = Math.ceil(count / BLOCK);
    const groups = groupsOf(count);
    // The groups that each training splat searches, kept between iterations.
    const pickBytes = groups ? TRAIN_PROBES * 2 : 0;
    if (groups)
      picks = array(workspace, Uint16Array, training.length * TRAIN_PROBES);
    // Jobs are small enough for every thread to take several.
    const parts = workspace ? availableParallelism() * 8 : 1;
    const size = Math.max(
      4,
      Math.min(JOB, Math.ceil(training.length / parts / 4) * 4),
    );
    let threads = 0;
    if (workspace) {
      // Each thread's kernel and the buffers of its jobs: half bits, labels,
      // weights and groups of their rows.
      const bytes =
        kernelBytes(dims, blocks, groups, scratchBytes(module, dims, groups)) +
        WINDOW * size * (rowBytes + labelBytes + 8 + pickBytes);
      // This thread's arrays, and its own kernel and jobs when there is no
      // room for workers.
      const extra = ownBytes(dims, count, blocks, groups) + bytes;
      // Reserve before allocating the codes and accumulators, so their
      // memory is not already in the RSS measurement that clusterers() adds
      // to. Without a workspace the caller has planned the memory; see
      // clusterBytes().
      threads = clusterers(
        workspace,
        bytes,
        extra,
        Math.ceil(training.length / size),
      );
    }
    // Measure worker growth between passes: bypass reads do not allocate
    // pages or trigger measurements. Leave room for the splats' groups, and
    // for labels when the final pass shares the training cache.
    const reserved =
      Math.ceil((training.length * pickBytes) / PAGE_BYTES) +
      (sampled ? 0 : Math.ceil((length * labelBytes) / PAGE_BYTES));
    const keep = () => {
      if (!workspace) return;
      workspace.adjust();
      training.keep(workspace.capacity - reserved * PAGE_BYTES);
    };
    keep();
    const codes = new Float64Array(count * dims);
    // The threads add to the sums, each to those of its share of the
    // entries, and read and write the jobs' splats in their slots.
    const sums = shared(Float64Array, count * dims);
    const totals = shared(Float64Array, count);
    const slots = WINDOW * Math.max(1, threads);
    const jobs = {
      buffer: new SharedArrayBuffer(
        slots * size * (rowBytes + labelBytes + 8 + pickBytes),
      ),
      slots,
      size,
      dims,
      halves: Type === Uint16Array,
      wide: LabelArray === Uint32Array,
      probes: groups ? TRAIN_PROBES : 0,
    };
    const bits = new Type(dims);
    // Read seeds past the cached prefix directly, preserving training rows.
    for (let c = 0; c < count; c++) {
      // Spark computes the seed rows in single precision.
      const row = Math.floor(
        Math.fround(Math.fround(c / count) * Math.fround(training.length)),
      );
      training.bands(Math.min(row, training.length - 1), 1, bits);
      for (let d = 0; d < dims; d++) codes[c * dims + d] = valueAt(bits, d);
    }
    // Points and codes are taken relative to the seeds' mean: the expanded
    // distances then round with the spread of the coefficients, not their
    // offset from zero.
    const center = new Float64Array(dims);
    for (let c = 0; c < count; c++)
      for (let d = 0; d < dims; d++) center[d] += codes[c * dims + d];
    for (let d = 0; d < dims; d++) center[d] /= count;
    assigner = new Assigner(
      module,
      dims,
      blocks,
      groups,
      { jobs, sums, totals },
      threads,
    );
    const grouper = groups && new Grouper(count, dims, center, groups);
    const order = !groups && identity(count);
    const blocked = !groups && shared(Float32Array, blocks * BLOCK * dims);
    const norms = !groups && shared(Float32Array, blocks * BLOCK);
    // The jobs whose slots are free.
    const free = jobBuffers(jobs);
    for (let pass = 0; pass <= iterations; pass++) {
      const last = pass === iterations;
      const rows = last ? all : training;
      // Whether the splats search the groups that an earlier iteration found:
      // each of those has codes when every group has.
      let reuse = false;
      if (grouper) {
        const { full, layout: grouped } = await grouper.group(codes, assigner);
        reuse = !last && full && pass % SEARCH_EVERY !== 0;
        await assigner.use("groups", {
          ...grouped,
          probes: last ? FINAL_PROBES : TRAIN_PROBES,
        });
      } else {
        layout(codes, order, dims, center, blocked, norms);
        await assigner.use("codes", { codes: blocked, norms, center });
      }
      keep();
      if (!last) {
        sums.fill(0);
        totals.fill(0);
      }
      const take = (index) => {
        check();
        const job = free.pop();
        job.index = index;
        job.base = index * size;
        job.count = Math.min(size, rows.length - job.base);
        // The final pass weighs its splats only for the distance that its
        // progress shows.
        if (last && !workspace) rows.bands(job.base, job.count, job.bits);
        else rows.read(job.base, job.count, job.bits, job.weights);
        // The final pass searches more groups than the iterations keep.
        job.pick = Boolean(picks) && !last;
        job.reuse = reuse;
        if (reuse)
          picks.read(
            job.base * TRAIN_PROBES,
            job.picks,
            job.count * TRAIN_PROBES,
          );
        return job;
      };
      // The distance shows with the final pass's progress only: summing it
      // in every pass held this thread up.
      let total = 0;
      let distance = 0;
      const progress =
        workspace &&
        new Progress(
          `Clustering ${label} ${pass + 1}/${iterations + 1}`,
          rows.length,
        );
      const consume = (done) => {
        const { bits, weights, labels: nearest } = done;
        if (last) {
          labels.write(done.base, nearest, done.count);
          for (let i = 0; progress && i < done.count; i++) {
            const at = nearest[i] * dims;
            let squared = 0;
            for (let d = 0; d < dims; d++) {
              const offset = valueAt(bits, i * dims + d) - codes[at + d];
              squared += offset * offset;
            }
            total += weights[i];
            distance += weights[i] * squared;
          }
        } else if (done.pick && !reuse)
          picks.write(
            done.base * TRAIN_PROBES,
            done.picks,
            done.count * TRAIN_PROBES,
          );
        progress?.update(done.base + done.count);
      };
      await assigner.run(
        Math.ceil(rows.length / size),
        take,
        consume,
        (job) => free.push(job),
        !last,
      );
      progress?.finish(
        last
          ? `mean squared distance ${(distance / total).toExponential(3)}`
          : "",
      );
      if (last) break;
      let moved = false;
      for (let c = 0; c < count; c++)
        if (totals[c] > 0)
          for (let d = 0; d < dims; d++) {
            const value = sums[c * dims + d] / totals[c];
            if (value !== codes[c * dims + d]) moved = true;
            codes[c * dims + d] = value;
          }
      // An iteration that searched anew, with settled groups, and moved no
      // entry would find the same again: the others are skipped. Splats
      // whose SH are all alike end here after the first.
      if (!moved && !reuse && (!grouper || grouper.still))
        pass = iterations - 1;
    }
    return { count, dims, codes, labels };
  } catch (error) {
    labels.dispose();
    throw error;
  } finally {
    await assigner?.close();
    picks?.dispose();
    if (sampled) training.dispose();
  }
}
