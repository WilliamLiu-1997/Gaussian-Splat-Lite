import { abortable } from "../../runtime/abort";
import { positiveInteger } from "./streamOptions";

type StreamWorker = {
  disposed: boolean;
  peakWasmMemoryBytes: number;
  dispose(reason?: unknown): void;
};
type Slot<W> = {
  worker: W;
  busy: boolean;
  references: number;
};

/** Bounded worker leases. Cache handles retain slots; cancellation never kills unrelated work. */
export class StreamWorkerPool<W extends StreamWorker> {
  private readonly slots: Slot<W>[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly controller = new AbortController();
  private peakBytes = 0;

  constructor(
    private readonly createWorker: () => W,
    readonly concurrency: number,
    private readonly retainIdle = false,
  ) {
    positiveInteger(concurrency, "maxConcurrentLoads");
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

  private retire(slot: Slot<W>) {
    this.peakBytes = this.peakWasmMemoryBytes;
    if (!this.retainIdle && !slot.busy && !slot.references)
      slot.worker.dispose();
  }

  async acquire(signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      this.controller.signal.throwIfAborted();
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
            if (released)
              throw new Error("Cannot retain a released worker lease");
            owner.references++;
            let retained = true;
            return () => {
              if (!retained) return;
              retained = false;
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
      let wake!: () => void;
      const available = new Promise<void>((resolve) => {
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

  private wake() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  dispose(
    reason: unknown = new DOMException(
      "Streaming worker pool disposed",
      "AbortError",
    ),
  ) {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason);
    this.peakBytes = this.peakWasmMemoryBytes;
    for (const { worker } of this.slots) worker.dispose(reason);
    this.wake();
  }
}
