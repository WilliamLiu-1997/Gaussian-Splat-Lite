// Heap sizes match c/webp/CMakeLists.txt; preset 1 is budgeted at 15x input size.
// The heap starts at its initial size and grows only past it.
const MEMORY_LIMIT = 2 * 1024 ** 3;
const MEMORY_BASE = 16 * 1024 ** 2;
const MEMORY_FACTOR = 15;

export const webpBytes = (bytes) =>
  Math.max(MEMORY_BASE, bytes * MEMORY_FACTOR);
export const WEBP_MAX_PIXELS = Math.floor(
  (MEMORY_LIMIT - MEMORY_BASE) / (4 * MEMORY_FACTOR),
);

// imageSize() rounds both sides up to multiples of four.
export const MAX_CHUNK_SPLATS =
  (Math.floor(Math.sqrt(WEBP_MAX_PIXELS) / 4) * 4) ** 2;
