/** Start a worker with its own RPC table and WASM instance. */
export declare function startWorker(
  rpcHandlers: Record<string, (...args: never[]) => unknown>,
): void;
