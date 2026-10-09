import { getTransferable } from "./transferable.js";
import { WASM_MODULE } from "./wasm.js";
/** Transport/cache loss is recoverable by obtaining a fresh worker. */
export class WorkerTerminatedError extends Error {
  constructor(reason = "Worker terminated") {
    super(String(reason));
    this.name = "WorkerTerminatedError";
  }
}
/** Typed main-thread transport shared by ordinary and streaming workers. */
export class WorkerRpc {
  static {
    WorkerRpc.currentId = 0;
  }
  constructor(worker, onDispose) {
    this.worker = worker;
    this.onDispose = onDispose;
    this.messages = {};
    this.peakWasmMemoryBytes = 0;
    this.disposed = false;
    this.worker.onmessage = (event) => this.onMessage(event);
    this.worker.onerror = (event) =>
      this.dispose(new WorkerTerminatedError(event.message));
    this.worker.onmessageerror = () =>
      this.dispose(new WorkerTerminatedError("Invalid worker message"));
    void WASM_MODULE.then((module) => {
      if (!this.disposed)
        this.worker.postMessage({ name: "init-wasm", module });
    }).catch((error) => this.dispose(error));
  }
  onMessage(event) {
    const { id, result, error, fatal, status, wasmMemoryBytes } = event.data;
    const promise = this.messages[id];
    if (fatal) {
      // Every pending call failed with this instance, not a transient transport
      // loss. Keep the fatal classification when retiring the worker.
      Object.defineProperty(error, "fatal", { value: true });
      this.dispose(error);
      return;
    }
    if (!promise) return;
    if (status !== undefined) {
      const handle = () => {
        if (this.messages[id] === promise) return promise.onStatus?.(status);
      };
      promise.statusQueue = promise.statusQueue.then(handle);
      void promise.statusQueue.catch((error) => this.dispose(error));
      return;
    }
    this.peakWasmMemoryBytes = Math.max(
      this.peakWasmMemoryBytes,
      wasmMemoryBytes,
    );
    void promise.statusQueue
      .then(() => {
        if (error !== undefined) throw error;
        return result;
      })
      .then(promise.resolve, promise.reject);
  }
  async call(name, args, options = {}) {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new WorkerTerminatedError();
    const id = ++WorkerRpc.currentId;
    const promise = new Promise((resolve, reject) => {
      this.messages[id] = {
        resolve: (value) => resolve(value),
        reject,
        onStatus: options.onStatus,
        statusQueue: Promise.resolve(),
      };
    });
    // Pool jobs own their worker exclusively. Termination also interrupts
    // synchronous WASM decoding and releases its linear memory immediately.
    const abort = () => this.dispose(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      this.worker.postMessage(
        { id, name, args },
        { transfer: getTransferable(args) },
      );
      return await promise;
    } finally {
      delete this.messages[id];
      options.signal?.removeEventListener("abort", abort);
    }
  }
  dispose(reason = new Error("Worker terminated")) {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    const messages = Object.values(this.messages);
    this.messages = {};
    for (const message of messages) {
      message.reject(reason);
    }
    this.onDispose?.();
  }
}
