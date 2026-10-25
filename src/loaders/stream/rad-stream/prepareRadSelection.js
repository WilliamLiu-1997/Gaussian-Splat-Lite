import {
  RAD_PAGE_SIZE,
  SPLAT_BOUNDS_BLOCK_SIZE,
} from "../../../data/defines.js";
import { resetSplatBounds, unionSplatBounds } from "../../../data/splatData.js";
/** The scheduler snapshots and pins resident pages before dispatching this work. */
export function prepareRadSelection({ selection, pools }, chunks) {
  const { fade, ...target } = selection;
  const indices = fade?.indices ?? selection.indices;
  return {
    selection: target,
    fade: !!fade,
    pools: pools.map((pool) => preparePool(indices, fade?.fades, pool, chunks)),
  };
}
function preparePool(
  indices,
  fades,
  { pageCount, opacityBlocks, ranges },
  chunks,
) {
  const count = ranges.reduce(
    (count, { start, end }) => count + end - start,
    0,
  );
  const target = new Uint32Array(count);
  // Each opacity word stores sixteen groups, while a selection word holds 32 bits.
  const selectedWords = new Uint32Array(opacityBlocks.length / 2);
  const selectedPages = new Uint32Array(pageCount);
  const dirtyLayers = new Uint8Array(pageCount);
  // Flags record current (1) and post-fade (2) block membership.
  const blockFlags = new Uint8Array(
    (opacityBlocks.length * 16) / SPLAT_BOUNDS_BLOCK_SIZE,
  );
  const centerOnlyBoundingBox = new Float32Array(6);
  const boundingBox = new Float32Array(6);
  resetSplatBounds(centerOnlyBoundingBox);
  resetSplatBounds(boundingBox);
  const final = fades
    ? {
        selectedPages: selectedPages.slice(),
        centerOnlyBoundingBox: centerOnlyBoundingBox.slice(),
        boundingBox: boundingBox.slice(),
      }
    : undefined;
  let finalCount = 0;
  let fadeKinds = 0;
  for (const { start, end, slot, chunkIndex, sourceBase } of ranges) {
    const chunk = chunks.get(chunkIndex);
    if (!chunk) throw new Error("RAD selection references a retired chunk");
    const { sourceToStorage: order, boundsBlocks } = chunk;
    const pageStart = slot * RAD_PAGE_SIZE;
    selectedPages[slot] = end - start;
    const selectedBlocks = [];
    for (let index = start; index < end; index++) {
      const source = pageStart + order[indices[index] - sourceBase];
      const fade = fades?.[index] ?? 0;
      selectedWords[source >>> 5] |= 1 << (source & 31);
      const block = Math.floor(source / SPLAT_BOUNDS_BLOCK_SIZE);
      if (!blockFlags[block]) {
        blockFlags[block] = 1;
        selectedBlocks.push(block);
      }
      fadeKinds |= fade;
      const word = source >>> 4;
      const shift = (source & 15) * 2;
      if (((opacityBlocks[word] >>> shift) & 3) !== fade + 1) {
        opacityBlocks[word] =
          (opacityBlocks[word] & ~(3 << shift)) | ((fade + 1) << shift);
        dirtyLayers[slot] = 1;
      }
      if (final && fade !== 2) {
        finalCount++;
        blockFlags[block] |= 2;
        final.selectedPages[slot]++;
      }
    }
    // Merge once per selected block, keeping bounds work out of the per-node loop.
    const blockBase = pageStart / SPLAT_BOUNDS_BLOCK_SIZE;
    for (const block of selectedBlocks) {
      const boundsOffset = (block - blockBase) * 12;
      unionSplatBounds(centerOnlyBoundingBox, boundsBlocks, boundsOffset);
      unionSplatBounds(boundingBox, boundsBlocks, boundsOffset + 6);
      if (final && blockFlags[block] & 2) {
        unionSplatBounds(
          final.centerOnlyBoundingBox,
          boundsBlocks,
          boundsOffset,
        );
        unionSplatBounds(final.boundingBox, boundsBlocks, boundsOffset + 6);
      }
    }
  }
  // Enumerate selected bits in Morton storage order without sorting the cut.
  // Unsorted stochastic draws traverse this order directly.
  let offset = 0;
  for (let word = 0; word < selectedWords.length && offset < count; word++) {
    let bits = selectedWords[word];
    while (bits) {
      target[offset++] = word * 32 + 31 - Math.clz32(bits & -bits);
      bits &= bits - 1;
    }
  }
  let finalSelection;
  if (final && fadeKinds & 2) {
    // The post-fade cut is a subset of the sorted target; omit outgoing group 3.
    const indices = new Uint32Array(finalCount);
    let offset = 0;
    for (let index = 0; index < target.length; index++) {
      const source = target[index];
      const group = (opacityBlocks[source >>> 4] >>> ((source & 15) * 2)) & 3;
      if (group !== 3) indices[offset++] = source;
    }
    finalSelection = { ...final, indices };
  }
  return {
    indices: target,
    centerOnlyBoundingBox,
    boundingBox,
    selectedPages,
    opacityBlocks,
    dirtyLayers,
    fadeKinds,
    final: finalSelection,
  };
}
