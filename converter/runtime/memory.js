import { webpHeapBytes } from "../../bin/sog/webp.js";
import { metadataBytes } from "./files.js";
import { workerOverhead } from "./host.js";
import { outputBufferBytes } from "./output.js";
import { threadCount } from "./threads.js";
import { writtenBytes } from "./written-pages.js";

export const sharedBuffer = (bytes) =>
  new SharedArrayBuffer(Math.ceil(bytes / 65536) * 65536);
export function collect() {}
export const unmeasuredBytes = (view) => view?.byteLength ?? 0;
const diskBytes = workerOverhead + 4 * 1024 ** 2 + writtenBytes;
let decoder;
export function trackDecoder(memory) {
  decoder = memory;
}

// The scheduler reserves each phase's WASM heaps, jobs and transient arrays
// before spawning. Charge live worker overhead as well as the decoder, two
// 1 MiB input buffers, an output write, file mappings and resident page descriptors.
export const outsideBytes = (cached) =>
  diskBytes +
  outputBufferBytes +
  workerOverhead * (1 + threadCount()) +
  2 * 1024 ** 2 +
  (decoder?.buffer.byteLength ?? 0) +
  webpHeapBytes() +
  metadataBytes() +
  (cached / 65536) * 512;
