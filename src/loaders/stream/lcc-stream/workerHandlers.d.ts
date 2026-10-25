import type {
  ReorderedSplatResult,
  SplatResult,
} from "../../../data/defines.js";
import type {
  SplatLoadArgs,
  SplatLoadStatus,
  SplatRequestOptions,
} from "../../loadTypes.js";
import type { LccChunk, LccStreamIndex } from "./lccIndex.js";
import type {
  LccSelectionRequest,
  LccSelectionResult,
} from "./lccSelection.js";
export type LccChunkInfo = {
  numSplats: number;
  numSh: number;
  byteLength: number;
};
export type LccRange = { start: number; count: number };
export type LccResourceVersion = {
  url: string;
  etag?: string;
  lastModified?: string;
  total?: number;
};
export type LccRequest = SplatRequestOptions & { url: string; baseUrl: string };
export declare function createLccStreamHandlers(
  decodeSplats: (
    args: SplatLoadArgs,
    options: { sendStatus: (status: SplatLoadStatus) => void },
  ) => Promise<SplatResult>,
  decodeRecords: (
    base: Uint8Array,
    sh: Uint8Array | undefined,
    interleaved: boolean,
    ranges: Float32Array,
  ) => SplatResult,
): {
  parseLccManifest: (args: {
    bytes: Uint8Array;
    baseUrl: string;
  }) => (LccStreamIndex & { retainedIndexBytes: number }) | undefined;
  parseLccIndex: (args: {
    bytes: Uint8Array;
    baseUrl: string;
  }) => LccStreamIndex & { retainedIndexBytes: number };
  selectLcc: (request: LccSelectionRequest) => LccSelectionResult;
  loadLccChunk: (
    args: {
      id: number;
      request: LccRequest;
      chunk: LccChunk;
      hasSh?: boolean;
      ranges?: Float32Array;
      sh?: LccRequest;
    },
    options: { sendStatus: (status: SplatLoadStatus) => void },
  ) => Promise<LccChunkInfo & { resources: LccResourceVersion[] }>;
  extractLccNodes: (args: {
    id: number;
    ranges: LccRange[];
  }) => ReorderedSplatResult[];
  releaseLccChunk: (args: { id: number }) => void;
};
