import type { RadMeta } from "../../rad/radFormat";
import { getRadChunkSpan } from "../../rad/radFormat";
import { type RadLodSelection, radChunkIndex } from "./radLod";

export type RadFade = {
  indices: Uint32Array;
  fades: Uint8Array;
};

export type RadStreamSelection = RadLodSelection & {
  changedChunks: Uint32Array;
  fade?: RadFade;
};

export function equalRadIndices(previous: Uint32Array, next: Uint32Array) {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index++)
    if (previous[index] !== next[index]) return false;
  return true;
}

/** Merge sorted tree cuts without drawing shared nodes twice. CPU transition
 * kinds: 0 stays opaque, 1 fades in, and 2 fades out. */
export function mergeRadFade(
  previous: Uint32Array,
  next: Uint32Array,
): RadFade | undefined {
  if (equalRadIndices(previous, next)) return undefined;
  if (!previous.length)
    return {
      indices: next,
      fades: new Uint8Array(next.length).fill(1),
    };

  const indices = new Uint32Array(previous.length + next.length);
  const fades = new Uint8Array(indices.length);
  let oldOffset = 0;
  let newOffset = 0;
  let count = 0;
  while (oldOffset < previous.length || newOffset < next.length) {
    const oldIndex = previous[oldOffset] ?? Number.POSITIVE_INFINITY;
    const newIndex = next[newOffset] ?? Number.POSITIVE_INFINITY;
    if (oldIndex === newIndex) {
      indices[count] = oldIndex;
      oldOffset++;
      newOffset++;
    } else if (oldIndex < newIndex) {
      indices[count] = oldIndex;
      fades[count] = 2;
      oldOffset++;
    } else {
      indices[count] = newIndex;
      fades[count] = 1;
      newOffset++;
    }
    count++;
  }
  return {
    indices: indices.subarray(0, count),
    fades: fades.subarray(0, count),
  };
}
/** Only pools containing changed nodes need new index/opacity maps. */
export function changedRadChunks(
  meta: RadMeta,
  previous: Uint32Array,
  next: Uint32Array,
) {
  const chunks: number[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let pageEnd = 0;
  while (oldOffset < previous.length || newOffset < next.length) {
    const oldIndex = previous[oldOffset] ?? Number.POSITIVE_INFINITY;
    const newIndex = next[newOffset] ?? Number.POSITIVE_INFINITY;
    if (oldIndex === newIndex) {
      oldOffset++;
      newOffset++;
      continue;
    }
    const index = Math.min(oldIndex, newIndex);
    if (oldIndex < newIndex) oldOffset++;
    else newOffset++;
    if (index < pageEnd) continue;
    const chunk = radChunkIndex(meta, index);
    const range = getRadChunkSpan(meta, chunk);
    pageEnd = range.base + range.count;
    chunks.push(chunk);
  }
  return Uint32Array.from(chunks);
}
