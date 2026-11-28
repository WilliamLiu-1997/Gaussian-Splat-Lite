import { MAX_WRITERS, PAGE_BYTES, SEGMENT_BYTES } from "./runtime/pages.js";
import { WrittenPages } from "./runtime/written-pages.js";

let directory;
let state;
let bytes;
let writes;
let failure;
let writeback;
const files = [];
const writers = new Map();
const reader = new FileReaderSync();
const recent = new WrittenPages();

function commit(index) {
  const writer = writers.get(index);
  writers.delete(index);
  const file = files[index];
  file.snapshot = undefined;
  file.committing = writer.close().finally(() => {
    file.committing = undefined;
  });
  return file.committing;
}

async function flush() {
  const commits = Array.from(writers.keys(), commit);
  const results = await Promise.allSettled(commits);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}

async function transfer(op, at, size) {
  const index = Math.floor(at / SEGMENT_BYTES);
  const position = at % SEGMENT_BYTES;
  files[index] ??= {
    dirty: new Uint8Array(SEGMENT_BYTES / PAGE_BYTES),
    handle: await directory.getFileHandle(String(index), {
      create: op === "write",
    }),
  };
  const file = files[index];
  if (file.committing) await file.committing;
  if (op === "write") {
    let stream = writers.get(index);
    if (!stream) {
      if (writers.size >= MAX_WRITERS)
        await commit(writers.keys().next().value);
      stream = await file.handle.createWritable({ keepExistingData: true });
      writers.set(index, stream);
      file.dirty.fill(0);
    }
    const data = writes.slice(at % writes.length, (at % writes.length) + size);
    await stream.write({
      type: "write",
      position,
      data,
    });
    recent.remember(at, data);
    file.dirty.fill(
      1,
      Math.floor(position / PAGE_BYTES),
      Math.ceil((position + size) / PAGE_BYTES),
    );
    return size;
  }
  let length = size;
  if (writers.has(index)) {
    // Reads start on a page boundary. Only the first page is required;
    // stop optional read-ahead before an unpublished change.
    const page = position / PAGE_BYTES;
    if (file.dirty[page]) {
      if (recent.read(at / PAGE_BYTES, bytes)) return PAGE_BYTES;
      await commit(index);
    } else {
      const limit = Math.ceil((position + size) / PAGE_BYTES);
      for (let i = page + 1; i < limit; i++) {
        if (file.dirty[i]) {
          length = (i - page) * PAGE_BYTES;
          break;
        }
      }
    }
  }
  file.snapshot ??= await file.handle.getFile();
  const chunk = reader.readAsArrayBuffer(
    file.snapshot.slice(position, position + length),
  );
  bytes.set(new Uint8Array(chunk));
  return chunk.byteLength;
}

self.onmessage = async ({ data }) => {
  if (data.directory) {
    ({ directory, state, bytes, writes } = data);
    self.postMessage("ready");
    return;
  }
  if (data.completion) {
    writeback = flush();
    try {
      await writeback;
    } catch (error) {
      failure = error;
      Atomics.store(data.completion, 1, -5);
    } finally {
      writeback = undefined;
      Atomics.store(data.completion, 0, 0);
      Atomics.notify(data.completion, 0);
    }
    return;
  }
  try {
    if (failure) throw failure;
    let count = 0;
    if (data.op === "flush") {
      await writeback;
      await flush();
    } else count = await transfer(data.op, data.at, data.size);
    Atomics.store(state, 1, count);
    Atomics.store(state, 0, 1);
  } catch (error) {
    const message = new TextEncoder()
      .encode(error?.message ?? String(error))
      .subarray(0, bytes.length);
    bytes.set(message);
    Atomics.store(state, 1, message.length);
    Atomics.store(state, 0, -1);
  } finally {
    Atomics.notify(state, 0);
  }
};
