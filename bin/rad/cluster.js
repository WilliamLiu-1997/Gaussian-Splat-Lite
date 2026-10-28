// SH codebook clustering adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { HALF } from "./math.js";
import { WorkerGroup, clusterers } from "./parallel.js";
import { Progress } from "./progress.js";
import { SH_DIMS } from "./splats.js";
import { PAGE_BYTES, PagedArray } from "./storage.js";

// Codebook entries at most: RAD labels are 16-bit.
const MAX_CODES = 65536;
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
// Splats per job of a thread, and per call of the kernel.
const JOB = 4096;
const BATCH = 1024;
// Jobs per thread that are read and not yet consumed, at most; a thread
// computes one at a time.
const WINDOW = 3;
// Codes per block of the kernel's layout.
const BLOCK = 8;
// With at least GROUPS × 32 entries, each pass searches only part of them:
// the entries are clustered into GROUPS groups, and each splat searches the
// entries of the groups with the nearest centers, TRAIN_PROBES of them in
// iterations and FINAL_PROBES in the final pass. Grouping takes GROUP_STEPS
// steps from evenly spaced entries, then one from the last pass's groups.
// On Elevator this fit the entries better than comparing all of them, as
// with few probes entries stay near their groups, in a twentieth of the
// time; the final pass gave 99% of splats their nearest entry.
const GROUPS = 512;
const TRAIN_PROBES = 2;
const FINAL_PROBES = 24;
const GROUP_STEPS = 4;

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

// Bytes of a kernel instance's memory for `blocks` blocks of codes, with the
// module's own 1 MiB, and for the groups of the final assignment, if any:
// each group may add a block, and `scratch` bytes for the search.
function kernelBytes(dims, blocks, groups, scratch) {
  return (
    ((blocks + groups) * BLOCK + groups) * (dims + 1) * 4 +
    groups * 8 +
    scratch +
    BATCH * (dims * 4 + 64 + 6) +
    1024 ** 2
  );
}

// A thread's instance of the kernel, with the codes in blocks of 8, their
// squared lengths, and room for a batch of points, the kernel's state and
// the labels; with `groups`, also room for the grouped codes, the groups'
// centers and table, and the search's scratch memory.
class Nearest {
  constructor(module, dims, blocks, groups) {
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
    this.state = align(this.points + BATCH * dims * 4);
    this.labels = this.state + (BATCH / 4) * 256;
    this.slots = align(this.labels + BATCH * 2);
    this.scratch = this.slots + BATCH * 4;
    const end =
      this.scratch +
      (groups ? exports.probed_scratch(BATCH, dims, groups, FINAL_PROBES) : 0);
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    const { buffer } = memory;
    this.codeView = new Float32Array(buffer, this.codes, slots * dims);
    this.normView = new Float32Array(buffer, this.norms, slots);
    this.centerView = new Float32Array(buffer, this.centers, centers * dims);
    this.centerNormView = new Float32Array(buffer, this.centerNorms, centers);
    this.startView = new Uint32Array(buffer, this.starts, groups);
    this.sizeView = new Uint32Array(buffer, this.sizes, groups);
    this.pointView = new Float32Array(buffer, this.points, BATCH * dims);
    this.labelView = new Uint16Array(buffer, this.labels, BATCH);
    this.slotView = new Uint32Array(buffer, this.slots, BATCH);
    this.center = new Float64Array(dims);
    this.warm = false;
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
      this.call(4);
      return true;
    }
    if (message.type === "group") {
      // For grouping, codes are the points: labels `count` of them from
      // `first` with their nearest centers, in shared memory.
      const { points, centers, norms, labels, first, count } = message;
      const { dims, pointView, labelView } = this;
      this.centerView.set(centers);
      this.centerNormView.set(norms);
      for (let start = first; start < first + count; start += BATCH) {
        const size = Math.min(BATCH, first + count - start);
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
    const { bits, labels, count } = message;
    const { dims, center, pointView, labelView, slotView, order } = this;
    for (let start = 0; start < count; start += BATCH) {
      const size = Math.min(BATCH, count - start);
      // Points relative to the center; the last fills the final group of 4.
      const rows = Math.ceil(size / 4) * 4;
      for (let i = 0; i < rows; i++) {
        const row = (start + Math.min(i, size - 1)) * dims;
        for (let d = 0; d < dims; d++)
          pointView[i * dims + d] = HALF[bits[row + d]] - center[d];
      }
      this.call(rows);
      if (!this.groups) labels.set(labelView.subarray(0, size), start);
      else
        for (let i = 0; i < size; i++) labels[start + i] = order[slotView[i]];
    }
    return { labels, bits };
  }

  call(rows) {
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
      this.scratch,
      this.slots,
    );
  }
}

if (!isMainThread && workerData?.codebook) {
  const { module, dims, blocks, groups } = workerData;
  const nearest = new Nearest(module, dims, blocks, groups);
  parentPort.on("message", (message) => {
    const result = nearest.handle(message);
    parentPort.postMessage(
      result,
      result === true ? [] : [result.labels.buffer, result.bits.buffer],
    );
  });
}

// Spreads nearest-code jobs over worker threads, or runs them on this thread
// without any.
class Assigner extends WorkerGroup {
  constructor(module, dims, blocks, groups, count) {
    super(
      new URL(import.meta.url),
      count,
      { codebook: true, module, dims, blocks, groups },
      count ? undefined : new Nearest(module, dims, blocks, groups),
      "SH clustering",
    );
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

  // Runs `jobs` jobs, each from `read(index)`, and passes each with its
  // labels to `consume` in job order. The buffers of a job travel to its
  // thread and back. No more than WINDOW jobs per thread are read but not
  // consumed: a slow job holds back the next instead of letting finished
  // ones pile up. A thread has one job at a time, as a job takes far longer
  // than its messages, so a slow thread holds back only that one. After a
  // failure no more start.
  run(jobs, read, consume) {
    const { threads } = this;
    const busy = threads.map(() => false);
    const results = new Map();
    let next = 0;
    let done = 0;
    let stopped = false;
    return new Promise((resolve, reject) => {
      const stop = (error) => {
        if (!stopped) reject(error);
        stopped = true;
      };
      const pump = () => {
        if (stopped) return;
        try {
          for (; results.has(done); done++) {
            consume(results.get(done));
            results.delete(done);
          }
          if (done === jobs) {
            stopped = true;
            resolve();
            return;
          }
          for (let t = 0; t < threads.length && next < jobs; t++) {
            if (busy[t]) continue;
            if (next - done >= WINDOW * threads.length) break;
            const job = read(next++);
            const { bits, labels, count } = job;
            busy[t] = true;
            this.request(threads[t], { bits, labels, count }, [
              bits.buffer,
              labels.buffer,
            ]).then((result) => {
              busy[t] = false;
              job.bits = result.bits;
              job.labels = result.labels;
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
    this.weigh(base, count, weights);
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

// Rows and weights sampled from other rows.
class Sample {
  constructor(workspace, dims) {
    this.dims = dims;
    this.length = 0;
    this.kept = Number.POSITIVE_INFINITY;
    this.bits = new PagedArray(workspace, Uint16Array);
    this.weights = new PagedArray(workspace, Float64Array);
  }

  keep(bytes) {
    this.kept = fitting(bytes, this.dims * 2 + 8, 2);
  }

  read(base, count, bits, weights) {
    const { dims, kept } = this;
    this.bits.scan(base * dims, bits, count * dims, kept * dims);
    this.weights.scan(base, weights, count, kept);
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
// from a histogram of the weights.
function sample(rows, size, workspace) {
  const { dims, length } = rows;
  const result = new Sample(workspace, dims);
  const bits = new Uint16Array(JOB * dims);
  const weights = new Float64Array(JOB);
  const picked = new Uint16Array(JOB * dims);
  const pickedWeights = new Float64Array(JOB);
  const progress = new Progress("Sampling SH for clustering", 2 * length);
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
    progress.update(base + count);
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
    progress.update(length + base + count);
  }
  progress.finish(`${result.length} of ${length} splats`);
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

// Groups codes for searches by group: k-means without weights, first from
// evenly spaced codes, then one step from the last groups, as codes move
// little between passes. Each step labels the codes with their nearest
// centers on the threads, then moves the centers to the means of their
// groups. Lays the codes out by group: the codes of each group fill whole
// blocks, and `order` maps positions to codes. Empty groups have infinitely
// far centers.
class Grouper {
  constructor(count, dims, center) {
    const blocks = Math.ceil(GROUPS / BLOCK);
    this.count = count;
    this.dims = dims;
    this.center = center;
    // The codes relative to the center, as points, and their groups.
    this.points = shared(Float32Array, count * dims);
    this.labels = shared(Uint16Array, count);
    this.means = undefined;
    this.sums = new Float64Array(GROUPS * dims);
    this.sizes = new Uint32Array(GROUPS);
    // Each group adds at most a block of fillers.
    const slots = (Math.ceil(count / BLOCK) + GROUPS) * BLOCK;
    this.layout = {
      codes: shared(Float32Array, slots * dims),
      norms: shared(Float32Array, slots),
      centers: shared(Float32Array, blocks * BLOCK * dims),
      centerNorms: shared(Float32Array, blocks * BLOCK),
      center,
    };
  }

  // Groups `codes` on the threads of `assigner` and returns their layout.
  async group(codes, assigner) {
    const { count, dims, center, points, labels, sums, sizes } = this;
    const result = this.layout;
    for (let c = 0; c < count; c++)
      for (let d = 0; d < dims; d++)
        points[c * dims + d] = codes[c * dims + d] - center[d];
    const steps = this.means ? 1 : GROUP_STEPS;
    if (!this.means) {
      this.means = new Float64Array(GROUPS * dims);
      for (let g = 0; g < GROUPS; g++) {
        const c = Math.floor((g * count) / GROUPS);
        this.means.set(codes.subarray(c * dims, (c + 1) * dims), g * dims);
      }
    }
    const { means } = this;
    for (let step = 0; step < steps; step++) {
      layout(
        means,
        identity(GROUPS),
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
      for (let g = 0; g < GROUPS; g++)
        if (sizes[g])
          for (let d = 0; d < dims; d++)
            means[g * dims + d] = sums[g * dims + d] / sizes[g];
    }
    const starts = new Uint32Array(GROUPS);
    const groupBlocks = new Uint32Array(GROUPS);
    let slots = 0;
    for (let g = 0; g < GROUPS; g++) {
      starts[g] = slots / BLOCK;
      groupBlocks[g] = Math.ceil(sizes[g] / BLOCK);
      slots += groupBlocks[g] * BLOCK;
    }
    const order = new Int32Array(slots).fill(-1);
    const filled = new Uint32Array(GROUPS);
    for (let c = 0; c < count; c++) {
      const g = labels[c];
      order[starts[g] * BLOCK + filled[g]++] = c;
    }
    layout(codes, order, dims, center, result.codes, result.norms);
    const nonempty = Int32Array.from({ length: GROUPS }, (_, g) =>
      sizes[g] ? g : -1,
    );
    layout(means, nonempty, dims, center, result.centers, result.centerNorms);
    return {
      ...result,
      starts,
      sizes: groupBlocks,
      // Positions that hold no code are never nearest.
      order: Uint16Array.from(order, (c) => Math.max(c, 0)),
    };
  }
}

// Clusters the splats' SH into a codebook of at most 65536 entries with
// weighted k-means as Spark does: entries start at evenly spaced splats,
// each of `iterations` moves them to the weighted mean of their splats, an
// entry without any stays, and a final pass labels each splat with its
// nearest entry. Weights are area × opacity. Training uses 10% of the
// splats, at least 64 per entry, sampled in proportion to their weights;
// with many entries, passes search only groups of them. Returns the
// entries, `count` rows of `dims` SH coefficients, and the labels.
export async function clusterSh(splats, iterations, module) {
  const { workspace, length } = splats;
  const dims = SH_DIMS.slice(0, splats.maxSh).reduce((a, b) => a + b, 0);
  const count = Math.min(length, MAX_CODES);
  const all = new Rows(splats, dims);
  const samples = Math.max(
    count * SAMPLES_PER_CODE,
    Math.round(length * SAMPLE_SHARE),
  );
  const sampled = length > samples;
  const training = sampled ? sample(all, samples, workspace) : all;
  const labels = new PagedArray(workspace, Uint16Array);
  let assigner;
  try {
    const blocks = Math.ceil(count / BLOCK);
    const groups = count >= GROUPS * 32 ? GROUPS : 0;
    // Jobs are small enough for every thread to take several.
    const size = Math.max(
      4,
      Math.min(
        JOB,
        Math.ceil(training.length / (availableParallelism() * 8) / 4) * 4,
      ),
    );
    // Each thread's kernel and the buffers of its jobs: half bits, labels
    // and weights of their rows.
    const scratch = groups
      ? new WebAssembly.Instance(module, {}).exports.probed_scratch(
          BATCH,
          dims,
          groups,
          FINAL_PROBES,
        )
      : 0;
    const bytes =
      kernelBytes(dims, blocks, groups, scratch) +
      WINDOW * size * (dims * 2 + 10);
    // This thread's arrays, its own kernel and jobs when there is no room for
    // workers, and the layout of the codes; for groups, the codes as points
    // with their groups, the groups' means and sums, and the grouped layout
    // with its order.
    const slots = (blocks + groups) * BLOCK;
    const extra =
      count * (dims * 16 + 8) +
      bytes +
      (groups
        ? count * (dims * 4 + 2) +
          groups * dims * 16 +
          (slots + groups) * (dims + 1) * 4 +
          slots * 6
        : blocks * BLOCK * (dims + 1) * 4);
    // Reserve before allocating the codes and accumulators, so their memory
    // is not already in the RSS measurement that clusterers() adds to.
    const threads = clusterers(
      workspace,
      bytes,
      extra,
      Math.ceil(training.length / size),
    );
    // Measure worker growth between passes: bypass reads do not allocate
    // pages or trigger measurements. Leave room for labels when the final
    // pass shares the training cache.
    const labelPages = sampled ? 0 : Math.ceil((length * 2) / PAGE_BYTES);
    const keep = () => {
      workspace.adjust();
      training.keep(workspace.capacity - labelPages * PAGE_BYTES);
    };
    keep();
    const codes = new Float64Array(count * dims);
    const sums = new Float64Array(count * dims);
    const totals = new Float64Array(count);
    const bits = new Uint16Array(dims);
    const weight = new Float64Array(1);
    // Read seeds past the cached prefix directly, preserving training rows.
    for (let c = 0; c < count; c++) {
      // Spark computes the seed rows in single precision.
      const row = Math.floor(
        Math.fround(Math.fround(c / count) * Math.fround(training.length)),
      );
      training.read(Math.min(row, training.length - 1), 1, bits, weight);
      for (let d = 0; d < dims; d++) codes[c * dims + d] = HALF[bits[d]];
    }
    // Points and codes are taken relative to the seeds' mean: the expanded
    // distances then round with the spread of the coefficients, not their
    // offset from zero.
    const center = new Float64Array(dims);
    for (let c = 0; c < count; c++)
      for (let d = 0; d < dims; d++) center[d] += codes[c * dims + d];
    for (let d = 0; d < dims; d++) center[d] /= count;
    assigner = new Assigner(module, dims, blocks, groups, threads);
    const grouper = groups && new Grouper(count, dims, center);
    const order = !groups && identity(count);
    const blocked = !groups && shared(Float32Array, blocks * BLOCK * dims);
    const norms = !groups && shared(Float32Array, blocks * BLOCK);
    // Jobs come back with their buffers, which are reused.
    const free = [];
    const take = (rows, index) => {
      workspace.check();
      const job = free.pop() ?? {
        bits: new Uint16Array(size * dims),
        labels: new Uint16Array(size),
        weights: new Float64Array(size),
      };
      job.index = index;
      job.base = index * size;
      job.count = Math.min(size, rows.length - job.base);
      rows.read(job.base, job.count, job.bits, job.weights);
      return job;
    };
    for (let pass = 0; pass <= iterations; pass++) {
      const last = pass === iterations;
      const rows = last ? all : training;
      if (grouper)
        await assigner.use("groups", {
          ...(await grouper.group(codes, assigner)),
          probes: last ? FINAL_PROBES : TRAIN_PROBES,
        });
      else {
        layout(codes, order, dims, center, blocked, norms);
        await assigner.use("codes", { codes: blocked, norms, center });
      }
      keep();
      if (!last) {
        sums.fill(0);
        totals.fill(0);
      }
      let total = 0;
      let distance = 0;
      const progress = new Progress(
        `Clustering SH ${pass + 1}/${iterations + 1}`,
        rows.length,
      );
      await assigner.run(
        Math.ceil(rows.length / size),
        (index) => take(rows, index),
        (done) => {
          const { bits, weights, labels: nearest } = done;
          for (let i = 0; i < done.count; i++) {
            const c = nearest[i];
            const w = weights[i];
            let squared = 0;
            for (let d = 0; d < dims; d++) {
              const value = HALF[bits[i * dims + d]];
              const offset = value - codes[c * dims + d];
              squared += offset * offset;
              if (!last) sums[c * dims + d] += w * value;
            }
            total += w;
            if (!last) totals[c] += w;
            distance += w * squared;
          }
          if (last) labels.write(done.base, nearest, done.count);
          free.push(done);
          progress.update(done.base + done.count);
        },
      );
      progress.finish(
        `mean squared distance ${(distance / total).toExponential(3)}`,
      );
      if (last) break;
      for (let c = 0; c < count; c++)
        if (totals[c] > 0)
          for (let d = 0; d < dims; d++)
            codes[c * dims + d] = sums[c * dims + d] / totals[c];
    }
    return { count, dims, codes, labels };
  } catch (error) {
    labels.dispose();
    throw error;
  } finally {
    await assigner?.close();
    if (sampled) training.dispose();
  }
}
