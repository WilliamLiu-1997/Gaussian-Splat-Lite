import v8 from "node:v8";
import { runInNewContext } from "node:vm";

export const outsideBytes = (cached) => process.memoryUsage.rss() - cached;
// RSS already includes live typed arrays.
export const unmeasuredBytes = () => 0;

// gc() on this thread and on worker threads started later: arenas that the
// cache releases, and garbage holding buffers, return their memory to the
// system only once collected.
v8.setFlagsFromString("--expose-gc");
globalThis.gc ??= runInNewContext("gc");
// Collects twice: a collection frees the memory of what the one before found.
export function collect() {
  globalThis.gc();
  globalThis.gc();
}

// Shared memory of at least `bytes`, as WebAssembly memory like the arenas
// below: it returns to the system once collected on every platform.
export function sharedBuffer(bytes) {
  const pages = Math.ceil(bytes / 65536);
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  }).buffer;
}
