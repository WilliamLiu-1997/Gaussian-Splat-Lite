import type { RadMeta } from "../../rad/radFormat";
import { getRadChunkSpan } from "../../rad/radFormat";

/** CPU-only data retained in the dataset worker, never GPU source storage. */
export type RadLodChunk = {
  centers: Float32Array;
  radii: Float32Array;
  childStart?: Uint32Array;
  childCount?: Uint16Array;
};

export type RadLodView = {
  /** Object-to-camera transform; doubles preserve large scene translations. */
  viewFromObject: number[];
  /** Pixels per camera-space unit at depth 1, including projection zoom. */
  pixelScale: number;
  orthographic: boolean;
};

export type RadLodRequest = {
  views: RadLodView[];
  splatBudget: number;
  pixelThreshold: number;
  residentChunks: number[];
  hysteresis?: number;
};

export type RadLodSelection = {
  /** Stable file indices. The scheduler maps these to occupied GPU slots. */
  indices: Uint32Array;
  wantedChunks: Uint32Array;
  /** Ancestor and selected pages required by this cut. */
  touchedChunks: Uint32Array;
};

/** Resolve global indices without assuming that chunks are 64K records. */
export function radChunkIndex(meta: RadMeta, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= meta.count)
    throw new Error("RAD tree index is out of range");
  const size = meta.chunkSize ?? meta.count;
  const candidate = Math.floor(index / size);
  if (candidate < meta.chunks.length) {
    const range = getRadChunkSpan(meta, candidate);
    if (index >= range.base && index < range.base + range.count)
      return candidate;
  }
  let low = 0;
  let high = meta.chunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const range = getRadChunkSpan(meta, middle);
    if (index < range.base) high = middle;
    else if (index >= range.base + range.count) low = middle + 1;
    else return middle;
  }
  throw new Error("RAD tree references a gap in the chunk directory");
}
