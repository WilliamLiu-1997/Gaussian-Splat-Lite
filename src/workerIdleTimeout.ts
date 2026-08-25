const MEBIBYTE = 1024 * 1024;

const SMALL_WORKER_MEMORY_BYTES = 64 * MEBIBYTE;
const LARGE_WORKER_MEMORY_BYTES = 256 * MEBIBYTE;
const SMALL_WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const LARGE_WORKER_IDLE_TIMEOUT_MS = 3 * 1000;

/**
 * Keep small workers around for reuse, while releasing workers whose WASM
 * linear memory has grown large much sooner.
 */
export function getWorkerIdleTimeoutMs(peakWasmMemoryBytes: number): number {
  const clampedMemoryBytes = Math.min(
    LARGE_WORKER_MEMORY_BYTES,
    Math.max(SMALL_WORKER_MEMORY_BYTES, peakWasmMemoryBytes),
  );
  const memoryRatio =
    (clampedMemoryBytes - SMALL_WORKER_MEMORY_BYTES) /
    (LARGE_WORKER_MEMORY_BYTES - SMALL_WORKER_MEMORY_BYTES);

  return Math.round(
    SMALL_WORKER_IDLE_TIMEOUT_MS +
      memoryRatio *
        (LARGE_WORKER_IDLE_TIMEOUT_MS - SMALL_WORKER_IDLE_TIMEOUT_MS),
  );
}

/**
 * Prefer the smallest idle worker so workers with large WASM heaps can reach
 * their shorter expiry timers. Equal-sized workers retain LIFO behavior.
 */
export function getWorkerReuseIndex(
  workers: readonly { peakWasmMemoryBytes: number }[],
): number {
  let selectedIndex = -1;
  let selectedMemoryBytes = Number.POSITIVE_INFINITY;

  for (let index = workers.length - 1; index >= 0; index -= 1) {
    const memoryBytes = workers[index].peakWasmMemoryBytes;
    if (memoryBytes < selectedMemoryBytes) {
      selectedIndex = index;
      selectedMemoryBytes = memoryBytes;
    }
  }

  return selectedIndex;
}
