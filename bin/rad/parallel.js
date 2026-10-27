import { availableParallelism } from "node:os";
import {
  Worker,
  isMainThread,
  parentPort,
  receiveMessageOnPort,
  workerData,
} from "node:worker_threads";
import { Lookup, NONE } from "./grid.js";
import { HALF, halfBits } from "./math.js";
import {
  INVALID,
  LATER,
  Merger,
  SH_DIMS,
  Similarities,
  filterRecord,
  refresh,
  validRecord,
} from "./splats.js";
import { ArenaViews, Parts, SharedColumn, collect } from "./storage.js";

// A search that the main thread does: a merge failed.
export const MISS = 0xfffffffe;
// The most searches in one round.
export const ROUND = 32768;
// Control words.
const GEN = 0;
const NEXT = 1;
const COUNT = 2;
const DONE = 3;
const VERSION = 4;
const JOB = 5;
const SIZE = 6;
const DIMS = 7;
// The length + 1 of a failed worker's error message in `failure`.
const FAILED = 8;
// A copy's row stride, first source row and target window.
const STRIDE = 10;
const BASE = 11;
const START = 12;
const END = 13;
// The workers that have collected the views of released arenas.
const COLLECTED = 14;
// Jobs.
const SEARCH = 0;
const BLEND = 1;
const COPY = 2;
const CHECK = 3;
const COLLECT = 4;
const TYPES = { Float32Array, Float64Array, Uint16Array, Uint32Array };
const MAX_DIMS = SH_DIMS[SH_DIMS.length - 1];

// Memory each LOD worker thread takes and each encoding worker thread with
// its chunk, with young generations of YOUNG_MB, measured on Linux and macOS;
// what the main thread grows by during the LOD; and the chunks the main
// thread holds for the encoders.
const WORKER_BYTES = 40 * 1024 ** 2;
const ENCODER_BYTES = 52 * 1024 ** 2;
const MAIN_BYTES = 64 * 1024 ** 2;
const CHUNKS_BYTES = 24 * 1024 ** 2;
// What an SH clustering worker thread takes besides its kernel and jobs,
// and the cache that clustering keeps: it reads rows in order.
const CLUSTER_BYTES = 32 * 1024 ** 2;
const STREAM_BYTES = 64 * 1024 ** 2;
export const YOUNG_MB = 8;

// Worker threads with `bytes` each: at most 8, using at most `share` of the
// budget and half the room left besides `extra`, as measured now.
function threads(workspace, bytes, extra, share = 1 / 4) {
  workspace.settle();
  return Math.max(
    0,
    Math.min(
      availableParallelism() - 1,
      8,
      Math.floor((workspace.budget * share) / bytes),
      Math.floor((workspace.room - extra) / 2 / bytes),
    ),
  );
}

// Makes room for the encoding worker threads of `chunks` and returns how
// many there are.
export function encoders(workspace, chunks) {
  const count = Math.min(
    threads(workspace, ENCODER_BYTES, CHUNKS_BYTES),
    chunks - 1,
  );
  workspace.expect(count * ENCODER_BYTES + CHUNKS_BYTES);
  return count;
}

// Makes room for SH clustering worker threads that take `bytes` each besides
// the thread itself, and `extra` bytes on this thread, and returns how many
// there are, at most `jobs`. They only compute, so they may use every other
// core and all the room but a small cache.
export function clusterers(workspace, bytes, extra, jobs) {
  workspace.settle();
  const each = CLUSTER_BYTES + bytes;
  const count = Math.max(
    0,
    Math.min(
      availableParallelism() - 1,
      jobs,
      Math.floor((workspace.room - extra - STREAM_BYTES) / each),
    ),
  );
  workspace.expect(count * each + extra);
  return count;
}

// Ordered request/reply workers for clustering and encoding. Their callers
// schedule the jobs and close the workers; without workers, requests use the
// local handler. Keep workers referenced so exit events can reject requests.
export class WorkerGroup {
  constructor(url, count, workerData, local, name) {
    this.local = local;
    this.workers = Array.from({ length: count }, () => {
      const worker = new Worker(url, {
        workerData,
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: YOUNG_MB,
        },
      });
      worker.waiting = [];
      worker.on("message", (result) => worker.waiting.shift().resolve(result));
      // A failed worker fails its pending and later requests.
      const fail = (error) => {
        worker.failed ??= error;
        for (const job of worker.waiting.splice(0)) job.reject(worker.failed);
      };
      worker.on("error", fail);
      worker.on("exit", (code) =>
        fail(new Error(`${name} worker exited (${code})`)),
      );
      return worker;
    });
  }

  get threads() {
    return this.workers.length ? this.workers : [undefined];
  }

  request(worker, message, transfer = []) {
    if (!worker) return Promise.resolve(this.local.handle(message));
    if (worker.failed) return Promise.reject(worker.failed);
    return new Promise((resolve, reject) => {
      worker.waiting.push({ resolve, reject });
      worker.postMessage(message, transfer);
    });
  }

  broadcast(message) {
    return Promise.all(
      this.threads.map((worker) => this.request(worker, message)),
    );
  }

  // Resolves once the workers have stopped and their memory is free.
  close() {
    return Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}

const shared = (Type, size) =>
  new Type(new SharedArrayBuffer(size * Type.BYTES_PER_ELEMENT));

// Whether a state value is unchanged; lists of directories compare by item.
const same = (a, b) =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, i) => value === b[i]));

// Runs jobs over the pages of shared PagedArrays in worker threads, with the
// main thread taking part: the searches and merges of a round of LOD merges,
// which the main thread then commits in order (see mergeLevels()), SH
// blending, column permutations and the checks of decoded splats. Searches
// read pages that are not cached from their files; the other jobs leave
// what is not cached to the main thread.
export class Pool {
  // Workers pay off for jobs over at least a batch of `splats`.
  constructor(workspace, splats) {
    this.workspace = workspace;
    // Once the LOD grid's entries, 64 bytes a splat, exceed three times the
    // budget, reads of pages dominate: the system serves no more of them
    // with more threads, and fewer threads leave more room for the cache.
    // The threads' share of the budget falls from a quarter in proportion,
    // to an eighth at twice that, below which it saves little.
    const share = Math.max(
      1 / 8,
      Math.min(1 / 4, (0.75 * workspace.budget) / (splats * 64)),
    );
    const count =
      splats < ROUND ? 0 : threads(workspace, WORKER_BYTES, MAIN_BYTES, share);
    this.shared = {
      cancelled: workspace.cancelled,
      control: shared(Int32Array, 16),
      // Bytes that threads read from files, for Workspace.readBytes.
      read: new BigInt64Array(new SharedArrayBuffer(8)),
      failure: shared(Uint8Array, 1024),
      // Each search's splat and its entry.
      nodes: shared(Uint32Array, ROUND),
      entries: shared(Uint32Array, ROUND),
      // Its candidate's entry, NONE or MISS; unless a MISS, the splat's
      // terms and weight and its candidate's node, the merged record and its
      // Similarities terms and the blend weights.
      results: shared(Uint32Array, ROUND),
      // Its score; see Lookup.find().
      metrics: shared(Float64Array, ROUND),
      queries: shared(Float64Array, ROUND * 14),
      partners: shared(Uint32Array, ROUND),
      // The slot of the merged splat's cell if found, else NONE.
      hints: shared(Uint32Array, ROUND),
      records: shared(Float32Array, ROUND * 16),
      terms: shared(Float32Array, ROUND * 13),
      blends: shared(Float64Array, ROUND * 2),
      // SH blending, with the children in `nodes` and `entries` and their
      // weights in `blends`: whether the main thread blends a row, as a
      // child is in the same batch, and the blended rows.
      later: shared(Uint8Array, ROUND),
      blended: shared(Uint16Array, ROUND * MAX_DIMS),
    };
    Object.assign(this, this.shared);
    this.generation = 0;
    // The workspace version and the arrays last sent, and the messages sent.
    this.version = -1;
    this.state = {};
    this.sent = 0;
    this.task = new Task(this.shared);
    workspace.expect(count * WORKER_BYTES + MAIN_BYTES);
    this.workers = Array.from({ length: count }, () => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: this.shared,
        resourceLimits: { maxYoungGenerationSizeMb: YOUNG_MB },
      });
      worker.unref();
      return worker;
    });
    workspace.collector = () => this.collect();
  }

  // Sends the workers the arrays a job reads, when they changed.
  share(state) {
    if (
      this.workspace.version === this.version &&
      Object.entries(state).every(([key, value]) =>
        same(this.state[key], value),
      )
    )
      return;
    this.version = this.workspace.version;
    Object.assign(this.state, state);
    // All arrays, so that no thread keeps views of released arenas.
    const message = {
      version: ++this.sent,
      arenas: this.workspace.arenas,
      generation: this.workspace.generation,
      ...this.state,
    };
    for (const worker of this.workers) worker.postMessage(message);
    this.task.use(message);
  }

  // Searches and merges for the first `count` nodes and entries, against the
  // grid as it is.
  search(grid, count) {
    const arrays = [grid.entries, grid.slots, grid.gone];
    this.share({
      entries: grid.entries.directory,
      slots: grid.slots.directory,
      gone: grid.gone.directory,
      files: arrays.map((array) => array.files()),
      capacity: grid.capacity,
      step: grid.step,
    });
    this.run(SEARCH, count, 32);
  }

  // Blends the rows of `column` of the first `count` children pairs in
  // `nodes` and `entries` with `blends` into `blended`, except rows marked
  // `later`, and marks them 0 in `results`. Rows that are not cached are left
  // to the main thread.
  blend(column, count, dims) {
    this.share({ column: column.directory });
    Atomics.store(this.control, DIMS, dims);
    this.run(BLEND, count, 512);
  }

  // Copies `count` rows of `source` from row `base` to rows of `output` at
  // their targets + 1 in `nodes` when those lie in [start, end). Marks rows
  // across pages or not cached in `later`, for the main thread.
  copy(source, output, stride, count, base, start, end, words = false) {
    this.share({
      source: source.directory,
      output: output.directory,
      type: words ? "Uint32Array" : source.Type.name,
    });
    const control = this.control;
    Atomics.store(control, STRIDE, stride);
    Atomics.store(control, BASE, base);
    Atomics.store(control, START, start);
    Atomics.store(control, END, end);
    this.run(COPY, count, 1024);
  }

  // Refreshes, checks and optionally crops `count` splats from `base` in
  // place, storing their filter states in `results`; see Splats.retain().
  check(splats, base, count, withinDist) {
    this.share({
      splatRecords: splats.records.directory,
      splatSh: splats.sh
        .slice(0, splats.maxSh)
        .map((column) => column.directory),
      withinDist,
    });
    Atomics.store(this.control, BASE, base);
    this.run(CHECK, count, 1024);
  }

  // Makes the workers drop their views of arenas that the workspace
  // released, and collect them.
  collect() {
    this.share({});
    this.run(COLLECT, 0, 1);
  }

  run(job, count, size) {
    this.workspace.check();
    const gen = ++this.generation;
    const control = this.control;
    Atomics.store(control, JOB, job);
    Atomics.store(control, SIZE, size);
    Atomics.store(control, COUNT, count);
    Atomics.store(control, DONE, 0);
    Atomics.store(control, NEXT, (gen & 0x7fff) << 16);
    Atomics.store(control, VERSION, this.sent);
    Atomics.store(control, COLLECTED, 0);
    Atomics.store(control, GEN, gen);
    Atomics.notify(control, GEN);
    this.task.begin();
    this.task.work(gen);
    for (;;) {
      this.workspace.check();
      const done = Atomics.load(control, DONE);
      if (done >= count) break;
      Atomics.wait(control, DONE, done, 100);
    }
    this.workspace.readBytes += Number(Atomics.exchange(this.read, 0, 0n));
    while (job === COLLECT) {
      this.workspace.check();
      const collected = Atomics.load(control, COLLECTED);
      // A failed worker no longer answers; its error is thrown below.
      if (collected >= this.workers.length || Atomics.load(control, FAILED))
        break;
      Atomics.wait(control, COLLECTED, collected, 100);
    }
    const failed = Atomics.load(control, FAILED);
    if (failed)
      throw new Error(
        `LOD worker failed: ${new TextDecoder().decode(this.failure.slice(0, failed - 1))}`,
      );
  }

  // Stops the workers. Their views and the main thread's would keep arenas
  // that the workspace releases.
  async close() {
    Atomics.store(this.control, GEN, -1);
    Atomics.notify(this.control, GEN);
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.task = undefined;
    this.workspace.collector = undefined;
  }
}

// The slot of the cell of merged center `m` that the last find visited: the
// query's cell or the cell of its best, at `b`; NONE if neither.
export function hint(lookup, m, q, b) {
  const inverse = lookup.inverse;
  const x = Math.floor(m[0] * inverse);
  const y = Math.floor(m[1] * inverse);
  const z = Math.floor(m[2] * inverse);
  if (
    x === Math.floor(q[0] * inverse) &&
    y === Math.floor(q[1] * inverse) &&
    z === Math.floor(q[2] * inverse)
  )
    return lookup.home;
  if (
    x === Math.floor(b[0] * inverse) &&
    y === Math.floor(b[1] * inverse) &&
    z === Math.floor(b[2] * inverse)
  )
    return lookup.near;
  return NONE;
}

// One thread's share of the rounds.
class Task {
  constructor(shared) {
    Object.assign(this, shared);
    this.version = -1;
    this.query = new Float64Array(14);
    this.other = new Float64Array(14);
    this.merged = new Float64Array(16);
    this.tuple = new Float64Array(13);
    this.merger = new Merger();
    this.similarities = new Similarities();
    // For the columns of searches: entries, slots and gone.
    this.parts = [Float32Array, Uint32Array, Uint32Array].map(
      (Type) => new Parts(Type),
    );
    this.views = new ArenaViews();
  }

  use(state) {
    this.version = state.version;
    this.views.use(state.arenas, state.generation);
    const views = this.views;
    if (state.entries) {
      const [entries, slots, gone] = [
        [state.entries, Float32Array],
        [state.slots, Uint32Array],
        [state.gone, Uint32Array],
      ].map(
        ([directory, Type], i) =>
          new SharedColumn(
            views,
            directory,
            Type,
            0,
            state.files[i],
            this.parts[i],
          ),
      );
      this.lookup = new Lookup(
        entries,
        slots,
        gone,
        state.capacity,
        state.step,
      );
    }
    if (state.column)
      this.column = new SharedColumn(views, state.column, Uint16Array);
    if (state.splatRecords) {
      this.withinDist = state.withinDist;
      this.splatRecords = new SharedColumn(
        views,
        state.splatRecords,
        Float32Array,
      );
      this.splatSh = state.splatSh.map(
        (directory) => new SharedColumn(views, directory, Uint16Array),
      );
    }
    if (state.source) {
      const Type = TYPES[state.type];
      this.source = new SharedColumn(views, state.source, Type);
      this.output = new SharedColumn(views, state.output, Type);
    }
  }

  // Forgets what searches read from files: pages change between jobs.
  begin() {
    for (const parts of this.parts) parts.reset();
  }

  // Claims chunks of the round `gen` until none are left.
  work(gen) {
    const control = this.control;
    for (;;) {
      if (this.cancelled && Atomics.load(this.cancelled, 0)) return;
      const next = Atomics.load(control, NEXT);
      if (next >>> 16 !== (gen & 0x7fff)) return;
      const start = next & 0xffff;
      if (start >= Atomics.load(control, COUNT)) return;
      const size = Atomics.load(control, SIZE);
      if (Atomics.compareExchange(control, NEXT, next, next + size) !== next)
        continue;
      const count = Atomics.load(control, COUNT);
      const end = Math.min(start + size, count);
      const job = Atomics.load(control, JOB);
      if (job === SEARCH)
        for (let t = start; t < end; t++) this.results[t] = this.search(t);
      else if (job === BLEND)
        this.blend(start, end, Atomics.load(control, DIMS));
      else if (job === COPY) this.copy(start, end);
      else {
        const base = Atomics.load(control, BASE);
        for (let i = start; i < end; i++)
          this.results[i] = this.check(base + i);
      }
      // Before the chunk counts as done, so the main thread finds it.
      let bytes = 0;
      for (const parts of this.parts) {
        bytes += parts.bytesRead;
        parts.bytesRead = 0;
      }
      if (bytes) Atomics.add(this.read, 0, BigInt(bytes));
      if (Atomics.add(control, DONE, end - start) + end - start === count)
        Atomics.notify(control, DONE);
    }
  }

  check(index) {
    const { splatRecords: records, merged: record } = this;
    records.missed = false;
    const values = records.page(index * 16);
    const offset = records.offset(index * 16);
    if (records.missed) return LATER;
    for (let d = 0; d < 16; d++) record[d] = values[offset + d];
    refresh(record);
    values[offset + 14] = record[14];
    values[offset + 15] = record[15];
    if (!validRecord(record)) return INVALID;
    for (let band = 0; band < this.splatSh.length; band++) {
      const dims = SH_DIMS[band];
      const column = this.splatSh[band];
      column.missed = false;
      const row = column.page(index * dims);
      const at = column.offset(index * dims);
      if (column.missed || ((index * dims) & column.mask) > column.items - dims)
        return LATER;
      for (let d = 0; d < dims; d++)
        if (!Number.isFinite(HALF[row[at + d]])) return INVALID;
    }
    return filterRecord(record, this.withinDist);
  }

  copy(from, to) {
    const { source, output, nodes, later, control } = this;
    const stride = Atomics.load(control, STRIDE);
    const base = Atomics.load(control, BASE);
    const start = Atomics.load(control, START);
    const end = Atomics.load(control, END);
    const last = source.items - stride;
    for (let i = from; i < to; i++) {
      later[i] = 0;
      const target = nodes[i] - 1;
      if (target < start || target >= end) continue;
      const s = (base + i) * stride;
      const t = target * stride;
      source.missed = false;
      output.missed = false;
      const values = source.page(s);
      const offset = source.offset(s);
      const out = output.page(t);
      const at = output.offset(t);
      if (
        source.missed ||
        output.missed ||
        (s & source.mask) > last ||
        (t & output.mask) > last
      ) {
        later[i] = 1;
        continue;
      }
      for (let d = 0; d < stride; d++) out[at + d] = values[offset + d];
    }
  }

  blend(start, end, dims) {
    const { column, nodes, entries, blends, later, blended, results } = this;
    const last = column.items - dims;
    for (let i = start; i < end; i++) {
      if (later[i]) continue;
      const a = nodes[i] * dims;
      const b = entries[i] * dims;
      column.missed = false;
      const left = column.page(a);
      const l = column.offset(a);
      const right = column.page(b);
      const r = column.offset(b);
      // A row across two pages is left to the main thread.
      if (
        column.missed ||
        (a & column.mask) > last ||
        (b & column.mask) > last
      ) {
        results[i] = MISS;
        continue;
      }
      results[i] = 0;
      const w = blends[i * 2];
      const v = blends[i * 2 + 1];
      for (let d = 0; d < dims; d++)
        blended[i * dims + d] = halfBits(
          HALF[left[l + d]] * w + HALF[right[r + d]] * v,
        );
    }
  }

  search(t) {
    const { lookup, query, other, merged } = this;
    lookup.read(this.entries[t], query);
    const best = lookup.find(query, this.nodes[t]);
    this.metrics[t] = lookup.metric;
    this.queries.set(query, t * 14);
    if (best === NONE) return best;
    this.partners[t] = lookup.read(best, other);
    try {
      this.merger.run(query, other, query[13], other[13], merged);
    } catch {
      // The main thread merges again and reports the error.
      return MISS;
    }
    this.records.set(merged, t * 16);
    this.hints[t] = hint(lookup, merged, query, other);
    this.terms.set(this.similarities.terms(merged, this.tuple), t * 13);
    this.blends[t * 2] = this.merger.w;
    this.blends[t * 2 + 1] = this.merger.v;
    return best;
  }
}

if (!isMainThread && workerData?.control) {
  const task = new Task(workerData);
  const control = task.control;
  for (let seen = 0; ; ) {
    Atomics.wait(control, GEN, seen);
    const gen = Atomics.load(control, GEN);
    if (gen < 0) break;
    seen = gen;
    try {
      const version = Atomics.load(control, VERSION);
      while (task.version < version) {
        const received = receiveMessageOnPort(parentPort);
        if (received) task.use(received.message);
      }
      task.begin();
      if (Atomics.load(control, JOB) === COLLECT) {
        collect();
        Atomics.add(control, COLLECTED, 1);
        Atomics.notify(control, COLLECTED);
        continue;
      }
      task.work(gen);
    } catch (error) {
      // Report the error and release the round, so the main thread throws it.
      // The thread ends, and its views with it, so it counts as collected.
      const message = new TextEncoder().encode(String(error?.stack ?? error));
      const length = Math.min(message.length, task.failure.length - 1);
      task.failure.set(message.subarray(0, length));
      Atomics.store(control, FAILED, length + 1);
      Atomics.store(control, DONE, Atomics.load(control, COUNT));
      Atomics.notify(control, DONE);
      Atomics.add(control, COLLECTED, 1);
      Atomics.notify(control, COLLECTED);
      break;
    }
  }
}
