import createWebp from "../decoder/webp.mjs";

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

let loading;
let module;

export function initializeWebp() {
  loading ??= createWebp().then((instance) => {
    module = instance;
  });
  return loading;
}

// A CLI thread that encoded locally may next convert another input.
export function releaseWebp() {
  loading = undefined;
  module = undefined;
}

// A synchronous consumer can use the WASM view until the encoder frees it.
export function encodeWebp(rgba, width, height, consume) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16383 ||
    height > 16383 ||
    rgba.length !== width * height * 4
  )
    throw new Error("Invalid WebP image dimensions");
  if (width * height > WEBP_MAX_PIXELS)
    throw new Error("Image exceeds the WebP encoder memory limit");

  const input = module._malloc(rgba.length);
  const result = module._malloc(8);
  let output = 0;
  try {
    if (!input || !result) throw new Error("WebP encoder ran out of memory");
    module.HEAPU8.set(rgba, input);
    if (!module._webp_encode(input, width, height, result, result + 4))
      throw new Error("WebP lossless encoding failed");
    output = module.HEAPU32[result >>> 2];
    const size = module.HEAPU32[(result + 4) >>> 2];
    const view = module.HEAPU8.subarray(output, output + size);
    if (!consume) return view.slice();
    consume(view);
  } finally {
    if (output) module._WebPFree(output);
    module._free(input);
    module._free(result);
  }
}
