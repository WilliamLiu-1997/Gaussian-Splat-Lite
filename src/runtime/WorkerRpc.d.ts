type PromiseRecord = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onStatus?: (data: unknown) => void | Promise<void>;
  statusQueue: Promise<void>;
};
/** Transport/cache loss is recoverable by obtaining a fresh worker. */
export declare class WorkerTerminatedError extends Error {
  constructor(reason?: unknown);
}
/** Typed main-thread transport shared by ordinary and streaming workers. */
export declare class WorkerRpc<
  Handlers extends {
    [K in keyof Handlers]: (...args: never[]) => unknown;
  },
> {
  readonly worker: Worker;
  private readonly onDispose?;
  messages: Record<number, PromiseRecord>;
  peakWasmMemoryBytes: number;
  disposed: boolean;
  static currentId: number;
  constructor(worker: Worker, onDispose?: (() => void) | undefined);
  onMessage(event: MessageEvent): void;
  call<Name extends keyof Handlers>(
    name: Name,
    args: Parameters<Handlers[Name]>[0],
    options?: {
      onStatus?: (data: unknown) => void | Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<Awaited<ReturnType<Handlers[Name]>>>;
  dispose(reason?: unknown): void;
}
export {};
