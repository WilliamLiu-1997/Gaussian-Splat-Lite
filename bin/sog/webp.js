import createWebp from "../decoder/webp.mjs";
import { WEBP_MAX_PIXELS } from "./image-limits.js";

let loading;
let module;

export const webpHeapBytes = () => module?.HEAPU8.byteLength ?? 0;

export function initializeWebp() {
  loading ??= createWebp().then(
    (instance) => {
      module = instance;
    },
    (error) => {
      throw new Error(
        `Could not initialize webp.wasm: ${error.message ?? error}`,
        {
          cause: error,
        },
      );
    },
  );
  return loading;
}

// A CLI thread that encoded locally may next convert another input.
export function releaseWebp() {
  loading = undefined;
  module = undefined;
}

// An output stream can consume this WASM view across multiple writes.
export async function encodeWebp(rgba, width, height, consume) {
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
    await consume(view);
  } finally {
    if (output) module._WebPFree(output);
    module._free(input);
    module._free(result);
  }
}
