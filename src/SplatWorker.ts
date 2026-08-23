import { getTransferable } from "./utils";
import { WASM_MODULE } from "./wasm";
import type { RpcHandlers } from "./worker";
import BundledWorker from "./worker?worker&inline";

type PromiseRecord = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onStatus?: (data: unknown) => void | Promise<void>;
  statusQueue: Promise<void>;
};

export class SplatWorker {
  worker: Worker;
  messages: Record<number, PromiseRecord> = {};
  static currentId = 0;

  constructor() {
    this.worker = new BundledWorker();
    this.worker.onmessage = (event) => this.onMessage(event);
    WASM_MODULE.then((module) => {
      this.worker.postMessage({ name: "init-wasm", module });
    });
  }

  onMessage(event: MessageEvent) {
    const { id, result, error, status } = event.data;
    const promise = this.messages[id];
    if (!promise) return;

    if (status !== undefined) {
      promise.statusQueue = promise.statusQueue.then(() => {
        if (this.messages[id] === promise) {
          return promise.onStatus?.(status);
        }
      });
      void promise.statusQueue.catch(() => {});
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

  async call<Name extends keyof RpcHandlers>(
    name: Name,
    args: Parameters<RpcHandlers[Name]>[0],
    options: {
      onStatus?: (data: unknown) => void | Promise<void>;
    } = {},
  ): Promise<Awaited<ReturnType<RpcHandlers[Name]>>> {
    type Result = Awaited<ReturnType<RpcHandlers[Name]>>;
    const id = ++SplatWorker.currentId;
    const promise = new Promise<Result>((resolve, reject) => {
      this.messages[id] = {
        resolve: (value) => resolve(value as Result),
        reject,
        onStatus: options.onStatus,
        statusQueue: Promise.resolve(),
      };
    });
    this.worker.postMessage(
      { id, name, args },
      { transfer: getTransferable(args) },
    );
    return promise;
  }

  dispose() {
    this.worker.terminate();

    const messages = Object.values(this.messages);
    this.messages = {};
    for (const message of messages) {
      message.reject(new Error("Worker terminate"));
    }
  }
}

class SplatWorkerPool {
  maxWorkers;
  numWorkers = 0;
  freelist: SplatWorker[] = [];
  queue: ((worker: SplatWorker) => void)[] = [];

  constructor(maxWorkers = 4) {
    this.maxWorkers = maxWorkers;
  }

  async withWorker<T>(
    callback: (worker: SplatWorker) => Promise<T>,
  ): Promise<T> {
    const worker = await this.allocWorker();
    try {
      return await callback(worker);
    } finally {
      this.freeWorker(worker);
    }
  }

  async allocWorker(): Promise<SplatWorker> {
    const worker = this.freelist.pop();
    if (worker) {
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

  freeWorker(worker: SplatWorker) {
    if (this.numWorkers > this.maxWorkers) {
      // Worker no longer needed
      worker.dispose();
      this.numWorkers -= 1;
      return;
    }

    const waiter = this.queue.shift();
    if (waiter) {
      waiter(worker);
      return;
    }

    this.freelist.push(worker);
  }
}

export const workerPool = new SplatWorkerPool();
