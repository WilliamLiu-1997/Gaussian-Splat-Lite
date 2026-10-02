import { wasm_allocation_failed } from "gaussian-splat-rs";

let failed = false;
let failure: unknown;

/** Known allocation failures; invalid array lengths and bounds traps are not OOM. */
export function isMemoryAllocationError(error: unknown) {
  return (
    error instanceof Error &&
    /out of memory|allocation failed|unable to grow (?:instance )?memory|cannot allocate memory/i.test(
      error.message,
    )
  );
}

export function wasmFailure() {
  return { failed, error: failure };
}

/** Free a WASM object unless a failure left its instance unrecoverable. */
export function wasmFree(value?: { free(): void }) {
  if (value && !failed) wasmCall(() => value.free());
}

/** Traps and glue allocation failures can leave Rust borrows unrecoverable. */
export function wasmCall<T>(call: () => T): T {
  if (failed) throw failure;
  try {
    return call();
  } catch (error) {
    let outOfMemory = isMemoryAllocationError(error);
    try {
      outOfMemory = wasm_allocation_failed() || outOfMemory;
    } catch {
      // The WASM instance may not be initialized; preserve the original error.
    }
    if (
      outOfMemory ||
      error instanceof WebAssembly.RuntimeError ||
      error instanceof RangeError ||
      error instanceof TypeError
    ) {
      failed = true;
      failure = error;
    }
    throw error;
  }
}
