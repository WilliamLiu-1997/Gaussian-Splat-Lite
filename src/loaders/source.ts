import { abortable } from "../runtime/abort";
import type { SplatRequestOptions } from "./loadTypes";

export type ByteSource = {
  size: number;
  url?: string;
  read(offset: number, length: number, retain?: boolean): Promise<Uint8Array>;
};

export function checkRange(offset: number, length: number, size?: number) {
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

export function joinBytes(chunks: Uint8Array[], length: number) {
  if (chunks.length === 1 && chunks[0].byteLength === length) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function collectBytes(
  read: () => Promise<Uint8Array | undefined>,
  maxBytes: number,
  progress: (bytes: number) => void,
  signal?: AbortSignal,
  validateChunk?: (chunk: Uint8Array, size: number) => void,
) {
  const chunks: Uint8Array[] = [];
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
  response: Response,
  maxBytes: number,
  progress: (bytes: number) => void,
  signal?: AbortSignal,
  validateChunk?: (chunk: Uint8Array, size: number) => void,
) {
  const reader = response.body?.getReader();
  try {
    if (!response.ok)
      throw new Error(`HTTP ${response.status} loading ${response.url}`);
    const announced = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(announced) && announced > maxBytes)
      throw new Error("Source response exceeds its byte limit");
    if (!reader) {
      const bytes = new Uint8Array(
        await abortable(response.arrayBuffer(), signal),
      );
      if (bytes.byteLength > maxBytes)
        throw new Error("Source response exceeds its byte limit");
      validateChunk?.(bytes, bytes.byteLength);
      progress(bytes.byteLength);
      return { chunks: [bytes], size: bytes.byteLength };
    }
    return await collectBytes(
      async () => {
        const { done, value } = await reader.read();
        return done ? undefined : value;
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
export function requestOptions(
  args: SplatRequestOptions,
  url: string,
  base?: string,
): RequestInit & { headers: Headers } {
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
export async function* prefetchOrdered<T>(
  count: number,
  concurrency: number,
  read: (index: number) => Promise<T>,
  signal?: AbortSignal,
) {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  )
    throw new Error("Invalid source prefetch count or concurrency");
  signal?.throwIfAborted();
  const pending = new Map<number, Promise<T>>();
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
      const value = await abortable(pending.get(index) as Promise<T>, signal);
      pending.delete(index);
      fill();
      yield value;
    }
  } finally {
    pending.clear();
  }
}
