import createWebp from "../decoder/webp.mjs";

// Heap sizes match c/webp/CMakeLists.txt; preset 1 is budgeted at 15x input size.
const MEMORY_LIMIT = 2 * 1024 ** 3;
const MEMORY_BASE = 16 * 1024 ** 2;
const MEMORY_FACTOR = 15;

export const webpBytes = (bytes) => MEMORY_BASE + bytes * MEMORY_FACTOR;
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

export function encodeWebp(rgba, width, height) {
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
    return module.HEAPU8.slice(output, output + size);
  } finally {
    if (output) module._WebPFree(output);
    module._free(input);
    module._free(result);
  }
}
