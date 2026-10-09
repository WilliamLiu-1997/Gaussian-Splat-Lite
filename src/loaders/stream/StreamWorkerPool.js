import { abortable, linkedAbortController } from "../../runtime/abort.js";
/** Bounded worker leases. Cache handles retain slots; cancellation never kills unrelated work. */
export class StreamWorkerPool {
  constructor(createWorker, concurrency, retainIdle = false) {
    this.createWorker = createWorker;
    this.concurrency = concurrency;
    this.retainIdle = retainIdle;
    this.slots = [];
    this.waiters = new Set();
    this.controller = new AbortController();
    this.peakBytes = 0;
    this.nextTaskId = 0;
    this.downloadedBytes = 0;
  }
  get workers() {
    return this.slots.map(({ worker }) => worker);
  }
  get peakWasmMemoryBytes() {
    this.peakBytes = Math.max(
      this.peakBytes,
      this.slots.reduce(
        (bytes, { worker }) => bytes + worker.peakWasmMemoryBytes,
        0,
      ),
    );
    return this.peakBytes;
  }
  retire(slot) {
    this.peakBytes = this.peakWasmMemoryBytes;
    if (!this.retainIdle && !slot.busy && !slot.references)
      slot.worker.dispose();
  }
  /** Shared RAD/SOG task lifecycle; format RPCs and cache ownership stay local. */
  async run(options, load) {
    const id = ++this.nextTaskId;
    const request = linkedAbortController(
      this.controller.signal,
      options.signal,
    );
    let lease;
    let cancel;
    let url;
    let loaded = 0;
    try {
      lease = await this.acquire(request.signal);
      const { worker } = lease;
      cancel = () => {
        if (!worker.disposed) void options.cancel(worker, id).catch(() => {});
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      request.signal.throwIfAborted();
      // Do not race load() against abort: synchronous decoding keeps its slot
      // until the worker replies. The format also checks before publishing.
      return await load({
        ...lease,
        id,
        signal: request.signal,
        start: (value) => {
          url = value;
          options.manager.itemStart(value);
          request.signal.throwIfAborted();
        },
        progress: (next) => {
          this.downloadedBytes += next - loaded;
          loaded = next;
        },
      });
    } catch (error) {
      cancel?.();
      if (url !== undefined) options.manager.itemError(url);
      throw error;
    } finally {
      if (cancel) request.signal.removeEventListener("abort", cancel);
      request.cleanup();
      lease?.release();
      if (url !== undefined) options.manager.itemEnd(url);
    }
  }
  async acquire(signal) {
    for (;;) {
      signal.throwIfAborted();
      let slot = this.slots.find((candidate) => !candidate.busy);
      if (!slot && this.slots.length < this.concurrency) {
        slot = {
          worker: this.createWorker(),
          busy: false,
          references: 0,
        };
        this.slots.push(slot);
      }
      if (slot) {
        if (slot.worker.disposed) {
          this.peakBytes = this.peakWasmMemoryBytes;
          slot.worker = this.createWorker();
          slot.references = 0;
        }
        const owner = slot;
        const worker = owner.worker;
        owner.busy = true;
        let released = false;
        return {
          worker,
          retain: () => {
            owner.references++;
            return () => {
              if (owner.worker === worker) {
                owner.references--;
                this.retire(owner);
              }
            };
          },
          release: () => {
            if (released) return;
            released = true;
            owner.busy = false;
            this.retire(owner);
            this.wake();
          },
        };
      }
      let wake;
      const available = new Promise((resolve) => {
        wake = resolve;
        this.waiters.add(wake);
      });
      try {
        await abortable(available, signal);
      } finally {
        this.waiters.delete(wake);
      }
    }
  }
  wake() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  dispose(
    reason = new DOMException("Streaming worker pool disposed", "AbortError"),
  ) {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason);
    this.peakBytes = this.peakWasmMemoryBytes;
    for (const { worker } of this.slots) worker.dispose(reason);
    this.wake();
  }
}
