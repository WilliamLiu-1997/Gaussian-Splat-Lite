import { WorkerRpc } from "./WorkerRpc.js";
import { abortable } from "./abort.js";
import BundledWorker from "./worker.js?worker&inline";
export class SplatWorker extends WorkerRpc {
  constructor(onDispose) {
    super(new BundledWorker(), onDispose);
  }
}
const MEBIBYTE = 1024 * 1024;
const SMALL_WORKER_MEMORY_BYTES = 64 * MEBIBYTE;
const LARGE_WORKER_MEMORY_BYTES = 256 * MEBIBYTE;
const SMALL_WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const LARGE_WORKER_IDLE_TIMEOUT_MS = 3 * 1000;
/**
 * Keep small workers around for reuse, while releasing workers whose WASM
 * linear memory has grown large much sooner.
 */
function getWorkerIdleTimeoutMs(peakWasmMemoryBytes) {
  const clampedMemoryBytes = Math.min(
    LARGE_WORKER_MEMORY_BYTES,
    Math.max(SMALL_WORKER_MEMORY_BYTES, peakWasmMemoryBytes),
  );
  const memoryRatio =
    (clampedMemoryBytes - SMALL_WORKER_MEMORY_BYTES) /
    (LARGE_WORKER_MEMORY_BYTES - SMALL_WORKER_MEMORY_BYTES);
  return Math.round(
    SMALL_WORKER_IDLE_TIMEOUT_MS +
      memoryRatio *
        (LARGE_WORKER_IDLE_TIMEOUT_MS - SMALL_WORKER_IDLE_TIMEOUT_MS),
  );
}
/**
 * Prefer the smallest idle worker so workers with large WASM heaps can reach
 * their shorter expiry timers. Equal-sized workers retain LIFO behavior.
 */
function getWorkerReuseIndex(workers) {
  let selectedIndex = -1;
  let selectedMemoryBytes = Number.POSITIVE_INFINITY;
  for (let index = workers.length - 1; index >= 0; index -= 1) {
    const memoryBytes = workers[index].peakWasmMemoryBytes;
    if (memoryBytes < selectedMemoryBytes) {
      selectedIndex = index;
      selectedMemoryBytes = memoryBytes;
    }
  }
  return selectedIndex;
}
class SplatWorkerPool {
  constructor(maxWorkers = 4) {
    this.maxWorkers = maxWorkers;
    this.heavyJobs = Promise.resolve();
    this.numWorkers = 0;
    this.freelist = [];
    this.idleWorkerTimeouts = new Map();
    this.queue = [];
  }
  async withWorker(callback, memoryHeavy = false, signal = undefined) {
    signal?.throwIfAborted();
    if (memoryHeavy) {
      const next = this.heavyJobs.then(() =>
        this.withWorker(callback, false, signal),
      );
      this.heavyJobs = next.then(
        () => {},
        () => {},
      );
      return abortable(next, signal);
    }
    return abortable(
      this.allocWorker().then(async (worker) => {
        try {
          signal?.throwIfAborted();
          return await callback(worker);
        } finally {
          this.freeWorker(worker);
        }
      }),
      signal,
    );
  }
  async allocWorker() {
    for (let index = this.freelist.length - 1; index >= 0; index--) {
      const worker = this.freelist[index];
      if (!worker.disposed) continue;
      clearTimeout(this.idleWorkerTimeouts.get(worker));
      this.idleWorkerTimeouts.delete(worker);
      this.freelist.splice(index, 1);
      this.numWorkers -= 1;
    }
    const workerIndex = getWorkerReuseIndex(this.freelist);
    if (workerIndex !== -1) {
      const worker = this.freelist.splice(workerIndex, 1)[0];
      clearTimeout(this.idleWorkerTimeouts.get(worker));
      this.idleWorkerTimeouts.delete(worker);
      return worker;
    }
    if (this.numWorkers < this.maxWorkers) {
      const worker = new SplatWorker();
      this.numWorkers += 1;
      return worker;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  freeWorker(worker) {
    if (worker.disposed) {
      this.numWorkers -= 1;
      const waiter = this.queue.shift();
      if (waiter) {
        this.numWorkers += 1;
        waiter(new SplatWorker());
      }
      return;
    }
    const waiter = this.queue.shift();
    if (waiter) {
      waiter(worker);
      return;
    }
    this.freelist.push(worker);
    const timeout = setTimeout(() => {
      this.idleWorkerTimeouts.delete(worker);
      // Removing an idle worker elsewhere cancels this timer.
      this.freelist.splice(this.freelist.indexOf(worker), 1);
      worker.dispose();
      this.numWorkers -= 1;
    }, getWorkerIdleTimeoutMs(worker.peakWasmMemoryBytes));
    this.idleWorkerTimeouts.set(worker, timeout);
  }
}
export const workerPool = new SplatWorkerPool();
