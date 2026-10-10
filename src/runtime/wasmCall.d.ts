/** Known allocation failures; invalid array lengths and bounds traps are not OOM. */
export declare function isMemoryAllocationError(error: unknown): boolean;
export declare function wasmFailure(): {
  failed: boolean;
  error: unknown;
};
/** Free a WASM object unless a failure left its instance unrecoverable. */
export declare function wasmFree(value?: {
  free(): void;
}): void;
/** Traps and glue allocation failures can leave Rust borrows unrecoverable. */
export declare function wasmCall<T>(call: () => T): T;
