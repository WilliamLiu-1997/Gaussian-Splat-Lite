import {
  RAD_PAGE_SIZE,
  SPLAT_BOUNDS_BLOCK_SIZE,
} from "../../../data/defines.js";
import { getSplatTextureBytes } from "../../../data/splatData.js";
/** Fixed page costs at the storage SH degree, including retained selection data. */
export function radPageCosts(numSh) {
  const splatBytes = getSplatTextureBytes(1, numSh);
  const boundsBlocks = RAD_PAGE_SIZE / SPLAT_BOUNDS_BLOCK_SIZE;
  const gpu = RAD_PAGE_SIZE * (splatBytes + 4 + 0.25) + 16;
  return {
    gpu,
    cpu: gpu + RAD_PAGE_SIZE * (4 + 28) + boundsBlocks * 72 + 2 * (48 + 4),
    pending: RAD_PAGE_SIZE * (splatBytes + 26) + boundsBlocks * 80,
  };
}
/** Resolve validated LOD indices without assuming that chunks are 64K records. */
export function radChunkIndex(meta, index) {
  const size = meta.chunkSize ?? meta.count;
  const candidate = Math.floor(index / size);
  if (candidate < meta.chunks.length) {
    const range = meta.chunks[candidate];
    if (index >= range.base && index < range.base + range.count)
      return candidate;
  }
  // Header validation guarantees contiguous, ordered spans covering every index.
  let low = 0;
  let high = meta.chunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (meta.chunks[middle].base <= index) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
