import type { SplatResult } from "../../../data/defines.js";
import type { SplatLoadArgs, SplatLoadStatus } from "../../loadTypes.js";
import type { SogStreamMetadata } from "./SogStreamLoader.js";
import type { SogLodRequest } from "./sogVisibility.js";
export type SogChunkInfo = {
  numSplats: number;
  numSh: number;
  byteLength: number;
};
/** LOD workers parse the index once before selection; other workers own chunk caches. */
export declare function createSogStreamHandlers(
  decodeSplats: (
    args: SplatLoadArgs,
    options: {
      sendStatus: (data: SplatLoadStatus) => void;
    },
  ) => Promise<SplatResult>,
): {
  loadSogChunk: (
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
  ) => Promise<SogChunkInfo>;
  cacheSogChunk: ({
    id,
    data,
    maxSh,
  }: {
    id: number;
    data: SplatResult;
    maxSh: number;
  }) => SogChunkInfo;
  extractSogRegions: ({
    id,
    ranges,
  }: {
    id: number;
    ranges: {
      start: number;
      count: number;
    }[];
  }) => import("../../../data/defines.js").ReorderedSplatResult[];
  releaseSogChunk: ({
    id,
  }: {
    id: number;
  }) => void;
  parseSogIndex: (request: { bytes: ArrayBuffer; baseUrl: string }) => void;
  initializeSogIndex: () => SogStreamMetadata & { retainedIndexBytes: number };
  selectSogLod: (request: SogLodRequest) => Uint32Array<ArrayBufferLike>;
};
