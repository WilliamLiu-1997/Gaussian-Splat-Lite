import { PAGE_BYTES } from "./pages.js";

// The coordinator and disk worker take turns using the same transfer buffer.
export async function externalHandle(directory) {
  const worker = new Worker(new URL("../disk-worker.js", import.meta.url), {
    type: "module",
    name: "GSL temporary disk",
  });
  const state = new Int32Array(new SharedArrayBuffer(8));
  const bytes = new Uint8Array(new SharedArrayBuffer(1024 ** 2));
  const writes = new Uint8Array(new SharedArrayBuffer(bytes.length));
  await new Promise((resolve, reject) => {
    worker.onmessage = resolve;
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage({ directory, state, bytes, writes });
  });
  function request(op, at, size) {
    Atomics.store(state, 0, 0);
    worker.postMessage({ op, at, size });
    while (!Atomics.load(state, 0)) {
      if (Atomics.wait(state, 0, 0, 120000) === "timed-out")
        throw new Error("The temporary disk did not respond.");
    }
    const n = Atomics.load(state, 1);
    if (Atomics.load(state, 0) < 0)
      throw new Error(new TextDecoder().decode(bytes.subarray(0, n)));
    return n;
  }
  let readStart = 0;
  let cached = 0;
  let first = 0;
  let end = 0;

  function writePending() {
    if (first === end) return;
    request("write", first, end - first);
    first = end;
  }
  function flush() {
    writePending();
    request("flush");
  }
  return {
    write(view, at) {
      const to = at + view.length;
      if (at < readStart + cached && to > readStart) cached = 0;
      // Released slots may be reused backwards. Adjacent or overlapping
      // writes can share a request in either order inside the same MiB.
      if (
        first !== end &&
        (to < first ||
          at > end ||
          Math.floor(at / writes.length) !== Math.floor(first / writes.length))
      )
        writePending();
      if (first === end) {
        first = at;
        end = to;
      } else {
        first = Math.min(first, at);
        end = Math.max(end, to);
      }
      writes.set(view, at % writes.length);
    },
    read(view, at) {
      const to = at + view.length;
      if (first !== end && at < end && to > first) {
        if (at >= first && to <= end) {
          const offset = at % writes.length;
          view.set(writes.subarray(offset, offset + view.length));
          return view.length;
        }
        writePending();
      }
      if (!cached || at < readStart || to > readStart + cached) {
        const sequential = cached && at === readStart + cached;
        readStart = at - (at % PAGE_BYTES);
        const size = sequential
          ? bytes.length - (readStart % bytes.length)
          : PAGE_BYTES;
        // A prefetched range must not cache an older image of buffered bytes.
        if (first !== end && first < readStart + size && end > readStart)
          writePending();
        cached = request("read", readStart, size);
      }
      const offset = at - readStart;
      const part = bytes.subarray(
        offset,
        Math.min(cached, offset + view.length),
      );
      view.set(part);
      return part.length;
    },
    submit(_files, completion) {
      try {
        writePending();
        worker.postMessage({ completion });
      } catch (error) {
        // Cleanup waits on this batch even when submission fails.
        Atomics.store(completion, 1, -5);
        Atomics.store(completion, 0, 0);
        throw error;
      }
    },
    flush,
    close() {
      try {
        flush();
      } finally {
        worker.terminate();
      }
    },
  };
}
