import { abortable } from "../runtime/abort.js";
export function checkRange(offset, length, size) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(offset + length) ||
    offset < 0 ||
    length < 0 ||
    (size !== undefined && offset + length > size)
  )
    throw new Error("Source byte range is out of bounds");
}
export function joinBytes(chunks, length) {
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function collectBytes(
  read,
  maxBytes,
  progress,
  signal,
  validateChunk,
) {
  const chunks = [];
  let size = 0;
  for (;;) {
    signal?.throwIfAborted();
    const bytes = await abortable(read(), signal);
    if (bytes === undefined) break;
    size += bytes.byteLength;
    if (size > maxBytes)
      throw new Error("Source response exceeds its byte limit");
    validateChunk?.(bytes, size);
    if (bytes.byteLength) chunks.push(bytes);
    progress(bytes.byteLength);
  }
  return { chunks, size };
}
export async function readResponse(
  response,
  maxBytes,
  progress,
  signal,
  validateChunk,
) {
  const reader = response.body?.getReader();
  try {
    if (!response.ok)
      throw new Error(`HTTP ${response.status} loading ${response.url}`);
    const announced = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(announced) && announced > maxBytes)
      throw new Error("Source response exceeds its byte limit");
    return await collectBytes(
      async () => {
        const chunk = await reader?.read();
        return chunk?.done ? undefined : chunk?.value;
      },
      maxBytes,
      progress,
      signal,
      validateChunk,
    );
  } catch (error) {
    await reader?.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
/** Each reader owns its Range header. Credentials only follow the original origin. */
export function requestOptions(args, url, base) {
  const sameOrigin = !base || new URL(url).origin === new URL(base).origin;
  const headers = new Headers(sameOrigin ? args.requestHeader : undefined);
  headers.delete("Range");
  headers.delete("If-Range");
  return {
    headers,
    credentials: sameOrigin && args.withCredentials ? "include" : "same-origin",
  };
}
/** Bounded ordered prefetch: consume in decoder order while later reads overlap. */
export async function* prefetchOrdered(count, concurrency, read, signal) {
  signal?.throwIfAborted();
  const pending = new Map();
  let next = 0;
  const fill = () => {
    while (next < count && pending.size < concurrency) {
      const index = next++;
      const task = Promise.resolve().then(() => read(index));
      void task.catch(() => {});
      pending.set(index, task);
    }
  };
  fill();
  try {
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      const value = await abortable(pending.get(index), signal);
      pending.delete(index);
      fill();
      yield value;
    }
  } finally {
    pending.clear();
  }
}
