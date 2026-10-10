import type { SplatRequestOptions } from "./loadTypes.js";
export type ByteSource = {
  size: number;
  url?: string;
  read(offset: number, length: number, retain?: boolean): Promise<Uint8Array>;
};
export declare function checkRange(
  offset: number,
  length: number,
  size?: number,
): void;
export declare function joinBytes(
  chunks: Uint8Array[],
  length: number,
): Uint8Array<ArrayBufferLike>;
export declare function collectBytes(
  read: () => Promise<Uint8Array | undefined>,
  maxBytes: number,
  progress: (bytes: number) => void,
  signal?: AbortSignal,
  validateChunk?: (chunk: Uint8Array, size: number) => void,
): Promise<{
  chunks: Uint8Array<ArrayBufferLike>[];
  size: number;
}>;
export declare function readResponse(
  response: Response,
  maxBytes: number,
  progress: (bytes: number) => void,
  signal?: AbortSignal,
  validateChunk?: (chunk: Uint8Array, size: number) => void,
): Promise<{
  chunks: Uint8Array<ArrayBufferLike>[];
  size: number;
}>;
/** Each reader owns its Range header. Credentials only follow the original origin. */
export declare function requestOptions(
  args: SplatRequestOptions,
  url: string,
  base?: string,
): RequestInit & {
  headers: Headers;
};
/** Bounded ordered prefetch: consume in decoder order while later reads overlap. */
export declare function prefetchOrdered<T>(
  count: number,
  concurrency: number,
  read: (index: number) => Promise<T>,
  signal?: AbortSignal,
): AsyncGenerator<Awaited<T>, void, unknown>;
