import { getTransferable } from "./transferable";
import { WASM_MODULE } from "./wasm";

type PromiseRecord = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onStatus?: (data: unknown) => void | Promise<void>;
  statusQueue: Promise<void>;
};

/** Typed main-thread transport shared by ordinary and streaming workers. */
export class WorkerRpc<
  Handlers extends { [K in keyof Handlers]: (...args: never[]) => unknown },
> {
  messages: Record<number, PromiseRecord> = {};
  peakWasmMemoryBytes = 0;
  disposed = false;
  static currentId = 0;

  constructor(
    readonly worker: Worker,
    private readonly onDispose?: () => void,
  ) {
    this.worker.onmessage = (event) => this.onMessage(event);
    this.worker.onerror = (event) => this.dispose(new Error(event.message));
    this.worker.onmessageerror = () =>
      this.dispose(new Error("Invalid worker message"));
    void WASM_MODULE.then((module) => {
      if (!this.disposed)
        this.worker.postMessage({ name: "init-wasm", module });
    }).catch((error) => this.dispose(error));
  }

  onMessage(event: MessageEvent) {
    const { id, result, error, status, wasmMemoryBytes } = event.data;
    if (Number.isSafeInteger(wasmMemoryBytes) && wasmMemoryBytes >= 0) {
      this.peakWasmMemoryBytes = Math.max(
        this.peakWasmMemoryBytes,
        wasmMemoryBytes,
      );
    }
    const promise = this.messages[id];
    if (!promise) return;

    if (status !== undefined) {
      promise.statusQueue = promise.statusQueue.then(() => {
        if (this.messages[id] === promise) {
          return promise.onStatus?.(status);
        }
      });
      void promise.statusQueue.catch((error) => this.dispose(error));
      return;
    }

    void promise.statusQueue
      .then(() => {
        if (error !== undefined) throw error;
        return result;
      })
      .finally(() => {
        delete this.messages[id];
      })
      .then(promise.resolve, promise.reject);
  }

  async call<Name extends keyof Handlers>(
    name: Name,
    args: Parameters<Handlers[Name]>[0],
    options: {
      onStatus?: (data: unknown) => void | Promise<void>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Awaited<ReturnType<Handlers[Name]>>> {
    type Result = Awaited<ReturnType<Handlers[Name]>>;
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Worker terminated");
    const id = ++WorkerRpc.currentId;
    const promise = new Promise<Result>((resolve, reject) => {
      this.messages[id] = {
        resolve: (value) => resolve(value as Result),
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
    } catch (error) {
      this.messages[id].reject(error);
      delete this.messages[id];
    }
    try {
      return await promise;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  dispose(reason: unknown = new Error("Worker terminated")) {
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
