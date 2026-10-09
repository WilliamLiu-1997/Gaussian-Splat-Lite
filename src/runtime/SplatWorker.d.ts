import { WorkerRpc } from "./WorkerRpc.js";
import type { RpcHandlers } from "./worker.js";
export declare class SplatWorker extends WorkerRpc<RpcHandlers> {
  constructor(onDispose?: () => void);
}
declare class SplatWorkerPool {
  private readonly maxWorkers;
  private heavyJobs;
  numWorkers: number;
  freelist: SplatWorker[];
  idleWorkerTimeouts: Map<SplatWorker, number>;
  queue: ((worker: SplatWorker) => void)[];
  constructor(maxWorkers?: number);
  withWorker<T>(
    callback: (worker: SplatWorker) => Promise<T>,
    memoryHeavy?: boolean,
    signal?: AbortSignal,
  ): Promise<T>;
  allocWorker(): Promise<SplatWorker>;
  freeWorker(worker: SplatWorker): void;
}
export declare const workerPool: SplatWorkerPool;
