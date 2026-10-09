import type { LoadingManager } from "three";
type StreamWorker = {
  disposed: boolean;
  peakWasmMemoryBytes: number;
  dispose(reason?: unknown): void;
};
type WorkerLease<W> = {
  worker: W;
  /** The retained cache handle releases this reference once on disposal. */
  retain: () => () => void;
  release: () => void;
};
type LoadTask<W> = WorkerLease<W> & {
  id: number;
  signal: AbortSignal;
  start: (url: string) => void;
  progress: (loaded: number) => void;
};
/** Bounded worker leases. Cache handles retain slots; cancellation never kills unrelated work. */
export declare class StreamWorkerPool<W extends StreamWorker> {
  private readonly createWorker;
  readonly concurrency: number;
  private readonly retainIdle;
  private readonly slots;
  private readonly waiters;
  private readonly controller;
  private peakBytes;
  private nextTaskId;
  downloadedBytes: number;
  constructor(createWorker: () => W, concurrency: number, retainIdle?: boolean);
  get workers(): W[];
  get peakWasmMemoryBytes(): number;
  private retire;
  /** Shared RAD/SOG task lifecycle; format RPCs and cache ownership stay local. */
  run<T>(
    options: {
      signal?: AbortSignal;
      manager: LoadingManager;
      cancel: (worker: W, id: number) => Promise<unknown>;
    },
    load: (task: LoadTask<W>) => Promise<T>,
  ): Promise<T>;
  private acquire;
  private wake;
  dispose(reason?: unknown): void;
}
export {};
