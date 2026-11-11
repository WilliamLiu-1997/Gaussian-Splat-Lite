import type {
  ReorderedSplatResult,
  SplatResult,
} from "../../../data/defines.js";
import type { SplatLoadArgs, SplatLoadStatus } from "../../loadTypes.js";
import type { SogLodRequest } from "../sog-stream/sogVisibility.js";
import type { ChunkStreamMetadata } from "./ChunkStreamLoader.js";

export type ChunkInfo = {
  /** Application-defined JSON from this chunk's SOG extras. */
  extra?: unknown;
  shPalette?: Uint32Array;
  shDegree?: 1 | 2 | 3 | 4;
  numSplats: number;
  numSh: number;
  byteLength: number;
  blindTextureCount: number;
};
/** LOD workers parse the index once before selection; other workers own chunk caches. */
export declare function createChunkStreamHandlers(
  decodeSplats: (
    args: SplatLoadArgs,
    options: {
      sendStatus: (data: SplatLoadStatus) => void;
    },
  ) => Promise<SplatResult>,
): {
  loadChunk: (
    {
      id,
      ...args
    }: SplatLoadArgs & {
      id: number;
      maxSh: number;
    },
    options: {
      sendStatus: (data: SplatLoadStatus) => void;
    },
  ) => Promise<ChunkInfo>;
  cacheChunk: ({
    id,
    data,
    maxSh,
    blindData,
  }: {
    id: number;
    data: SplatResult;
    maxSh: number;
    blindData?: boolean;
  }) => ChunkInfo;
  extractRegions: ({
    id,
    ranges,
  }: {
    id: number;
    ranges: {
      start: number;
      count: number;
    }[];
  }) => ReorderedSplatResult[];
  releaseChunk: ({
    id,
  }: {
    id: number;
  }) => void;
  parseIndex: (request: {
    id: number;
    bytes: ArrayBuffer;
    baseUrl: string;
    format?: "sog" | "lcc2";
  }) => ChunkStreamMetadata;
  releaseIndex: (request: { id: number }) => void;
  selectLod: (
    request: SogLodRequest & { format?: "sog" | "lcc2" },
  ) => Uint32Array<ArrayBufferLike>;
};
