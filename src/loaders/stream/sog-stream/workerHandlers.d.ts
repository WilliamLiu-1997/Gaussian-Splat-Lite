import type { SplatResult } from "../../../data/defines.js";
import type { SplatLoadArgs, SplatLoadStatus } from "../../loadTypes.js";
import type { SogView } from "./sogVisibility.js";
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
    },
    options: {
      sendStatus: (data: SplatLoadStatus) => void;
    },
  ) => Promise<SogChunkInfo>;
  cacheSogChunk: ({
    id,
    data,
  }: {
    id: number;
    data: SplatResult;
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
  parseSogIndex: ({
    bytes,
    baseUrl,
  }: {
    bytes: ArrayBuffer;
    baseUrl: string;
  }) => {
    bounds: Float64Array<ArrayBuffer>;
    leafOffsets: Uint32Array<ArrayBuffer>;
    lods: Float64Array<ArrayBuffer>;
    retainedIndexBytes: number;
    urls: string[];
    counts: Float64Array;
    environment?: string;
  };
  selectSogLod: ({
    view,
    budget,
  }: {
    view: SogView;
    budget: number;
  }) => Uint32Array<ArrayBufferLike>;
};
