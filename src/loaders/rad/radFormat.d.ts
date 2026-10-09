import type { ReorderedSplatResult, SplatResult } from "../../data/defines.js";
import type { PostDecodeSplatData } from "../postDecode/protocol.js";
export type RadChunkRange = {
  offset: number;
  bytes: number;
  base?: number;
  count?: number;
  filename?: string;
};
/** Spark RAD version 1 directory. Child references use file-global indices. */
export type RadMeta = {
  version: number;
  type: "gsplat";
  count: number;
  maxSh?: number;
  lodTree?: boolean;
  chunkSize?: number;
  allChunkBytes: number;
  chunks: RadChunkRange[];
  shCodeCount?: number;
  splatEncoding?: Record<string, unknown>;
  comment?: string;
};
export type RadHeader = {
  meta: RadMeta;
  chunksStart: number;
};
export type RadChunkData = SplatResult & {
  base: number;
  childStart?: Uint32Array;
  childCount?: Uint16Array;
  lodRadii?: Float32Array;
};
/** Render records for streaming; tree arrays are transferred to the LOD worker. */
export type RadStreamChunk = Omit<ReorderedSplatResult, "sortCenters"> & {
  /** Root-page radius used when its initial bounds collapse to one point. */
  rootRadius?: number;
};
export type RadDecodedChunk = PostDecodeSplatData & {
  base: number;
  childStart?: Uint32Array;
  childCount?: Uint16Array;
  lodRadii?: Float32Array;
};
export declare function unpackRadChunk(decoded: RadDecodedChunk): RadChunkData;
/** Without chunkSize, Spark treats the dataset as one chunk. */
export declare function getRadChunkSpan(
  meta: RadMeta,
  index: number,
): {
  base: number;
  count: number;
};
export declare function isRadPrefix(bytes: Uint8Array): boolean;
export declare function getRadHeaderSize(prefix: Uint8Array): {
  jsonLength: number;
  headerLength: number;
};
/** Validate the header as soon as a full-response fallback supplies it. */
export declare function collectRadHeader(
  complete: (bytes: Uint8Array) => void,
): (bytes: Uint8Array) => void;
