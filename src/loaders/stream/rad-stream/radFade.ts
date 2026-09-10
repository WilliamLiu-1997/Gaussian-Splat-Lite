import type { RadMeta } from "../../rad/radFormat";
import { getRadChunkSpan } from "../../rad/radFormat";
import { type RadLodSelection, radChunkIndex } from "./radLod";

export type RadFade = {
  indices: Uint32Array;
  fades: Uint8Array;
};

export type RadVersionedSelection = RadLodSelection & { selectionId: number };

export type RadStreamSelection = RadVersionedSelection & {
  changedChunks: Uint32Array;
  fade?: RadFade;
};

/** Compare sorted cuts and build their optional fade union in one pass. Allocate
 * the union only after a difference, so unchanged decisions allocate no fade. */
export function prepareRadFade(
  meta: RadMeta,
  previous: Uint32Array,
  next: Uint32Array,
  enableFade: boolean,
): Pick<RadStreamSelection, "changedChunks" | "fade"> {
  if (!enableFade)
    return { changedChunks: changedRadChunks(meta, previous, next) };
  let prefix = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (prefix < sharedLength && previous[prefix] === next[prefix]) prefix++;
  if (prefix === previous.length && prefix === next.length)
    return { changedChunks: new Uint32Array(0) };

  // The shared prefix occurs only once in the union. Copy it in bulk and keep
  // allocation checks outside the per-node loop.
  const indices = new Uint32Array(previous.length + next.length - prefix);
  const fades = new Uint8Array(indices.length);
  indices.set(next.subarray(0, prefix));
  const chunks: number[] = [];
  let oldOffset = prefix;
  let newOffset = prefix;
  let count = prefix;
  let pageEnd = 0;
  while (oldOffset < previous.length || newOffset < next.length) {
    const oldIndex = previous[oldOffset] ?? Number.POSITIVE_INFINITY;
    const newIndex = next[newOffset] ?? Number.POSITIVE_INFINITY;
    if (oldIndex === newIndex) {
      indices[count++] = oldIndex;
      oldOffset++;
      newOffset++;
      continue;
    }
    let index: number;
    if (oldIndex < newIndex) {
      index = oldIndex;
      fades[count] = 2;
      oldOffset++;
    } else {
      index = newIndex;
      fades[count] = 1;
      newOffset++;
    }
    indices[count++] = index;
    if (index < pageEnd) continue;
    const chunk = radChunkIndex(meta, index);
    const range = getRadChunkSpan(meta, chunk);
    pageEnd = range.base + range.count;
    chunks.push(chunk);
  }
  return {
    changedChunks: Uint32Array.from(chunks),
    fade: {
      indices: indices.subarray(0, count),
      fades: fades.subarray(0, count),
    },
  };
}

/** Diff-only path does not pay for union construction when fades are disabled. */
function changedRadChunks(
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
