import { getRadChunkSpan } from "../../rad/radFormat.js";
/** Resolve validated LOD indices without assuming that chunks are 64K records. */
export function radChunkIndex(meta, index) {
  const size = meta.chunkSize ?? meta.count;
  const candidate = Math.floor(index / size);
  if (candidate < meta.chunks.length) {
    const range = getRadChunkSpan(meta, candidate);
    if (index >= range.base && index < range.base + range.count)
      return candidate;
  }
  // Header validation guarantees contiguous, ordered spans covering every index.
  let low = 0;
  let high = meta.chunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (getRadChunkSpan(meta, middle).base <= index) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
