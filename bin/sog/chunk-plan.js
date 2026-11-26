import { clusterBytes, scratchEstimator } from "../rad/cluster.js";
import { GIB } from "../rad/storage.js";
import { entries } from "./cluster.js";
import { imageBytes } from "./encode.js";
import { chunkBufferBytes } from "./gather.js";
import { MAX_CHUNK_SPLATS } from "./image-limits.js";

// A range and its six f64 bounds have a copy in JS and in the bounds decoder.
const RANGE_BYTES = 8 + 48;

export function planChunks(levels, options, dims, blindCount, kernel, room) {
  const limit = Math.min(options.lodChunkCount, MAX_CHUNK_SPLATS);
  let largestRegion = 0;
  for (const [level, leaves] of levels.entries())
    for (const leaf of leaves)
      largestRegion = Math.max(largestRegion, leaf.lods[level]);
  if (largestRegion > limit) {
    const increase =
      largestRegion <= MAX_CHUNK_SPLATS ? " or increase --lod-chunk-count" : "";
    throw new Error(
      `A region has ${largestRegion} splats, more than the chunk limit of ${limit}; reduce --region-splats${increase}`,
    );
  }

  const scratch = scratchEstimator(kernel);
  let retained = 0;
  let bounds = 0;
  let working = 0;
  let gathered = 0;

  function reserve(count, ranges) {
    const codes = dims ? entries(count, options) : 0;
    const clustered = codes > 0 && codes < count;
    const buffer = chunkBufferBytes(count, dims, blindCount, clustered);
    if (buffer > 4 * GIB) return false;
    const image = imageBytes(count, dims, codes);
    const rangeBytes = ranges * RANGE_BYTES;
    // The gather buffer and both WASM heaps can grow on different chunks.
    // The decoder copies 12 bytes per row. JS geometry uses 24 bytes per row.
    const keep = Math.max(retained, buffer + image.retained);
    const decoder = Math.max(bounds, count * 12 + rangeBytes);
    let job = image.working + count * 24 + rangeBytes;
    if (clustered) job += clusterBytes(scratch, count, dims, codes);
    else if (codes) job += count * (dims * 4 + (codes <= 65536 ? 2 : 4));
    const peak = Math.max(working, job);
    if (keep + decoder + peak > room) return false;
    retained = keep;
    bounds = decoder;
    working = peak;
    gathered = Math.max(gathered, buffer);
    return true;
  }

  // Every unsplittable region must still fit after an earlier chunk ran.
  if (!reserve(largestRegion, 1))
    throw new Error(
      `Memory budget too small to encode a region of ${largestRegion} splats; reduce --region-splats or increase --memory-budget`,
    );

  const ends = [];
  for (const [level, leaves] of levels.entries()) {
    let start = 0;
    let count = 0;
    for (let i = 0; i < leaves.length; i++) {
      const rows = leaves[i].lods[level];
      if (count + rows > limit || !reserve(count + rows, i - start + 1)) {
        ends.push(i);
        start = i;
        count = 0;
      }
      count += rows;
    }
    if (leaves.length) ends.push(leaves.length);
  }
  return { ends, gathered, bytes: retained + bounds + working };
}
