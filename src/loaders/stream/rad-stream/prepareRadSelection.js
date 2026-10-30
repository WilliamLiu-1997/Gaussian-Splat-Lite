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
function emptyCut() {
  const centerOnlyBoundingBox = new Float32Array(6);
  const boundingBox = new Float32Array(6);
  resetSplatBounds(centerOnlyBoundingBox);
  resetSplatBounds(boundingBox);
  return { count: 0, centerOnlyBoundingBox, boundingBox };
}
function preparePool(
  indices,
  fades,
  { pageCount, opacityBlocks, ranges },
  chunks,
) {
  // Each page belongs to one input, whose view draws only that input's records.
  const cuts = new Map();
  const pageCuts = new Array(pageCount);
  // Each opacity word stores sixteen groups, while a selection word holds 32 bits.
  const selectedWords = new Uint32Array(opacityBlocks.length / 2);
  const selectedPages = new Uint32Array(pageCount);
  const finalSelectedPages = fades ? new Uint32Array(pageCount) : undefined;
  const dirtyLayers = new Uint8Array(pageCount);
  // Flags record current (1) and post-fade (2) block membership.
  const blockFlags = new Uint8Array(
    (opacityBlocks.length * 16) / SPLAT_BOUNDS_BLOCK_SIZE,
  );
  let fadeKinds = 0;
  for (const { start, end, slot, chunkIndex, sourceBase, input } of ranges) {
    const chunk = chunks.get(chunkIndex);
    if (!chunk) throw new Error("RAD selection references a retired chunk");
    const { sourceToStorage: order, boundsBlocks } = chunk;
    let cut = cuts.get(input);
    if (!cut) {
      cut = { ...emptyCut(), final: fades && emptyCut() };
      cuts.set(input, cut);
    }
    pageCuts[slot] = cut;
    cut.count += end - start;
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
      if (cut.final && fade !== 2) {
        cut.final.count++;
        blockFlags[block] |= 2;
        finalSelectedPages[slot]++;
      }
    }
    // Merge once per selected block, keeping bounds work out of the per-node loop.
    const blockBase = pageStart / SPLAT_BOUNDS_BLOCK_SIZE;
    for (const block of selectedBlocks) {
      const boundsOffset = (block - blockBase) * 12;
      unionSplatBounds(cut.centerOnlyBoundingBox, boundsBlocks, boundsOffset);
      unionSplatBounds(cut.boundingBox, boundsBlocks, boundsOffset + 6);
      if (cut.final && blockFlags[block] & 2) {
        unionSplatBounds(
          cut.final.centerOnlyBoundingBox,
          boundsBlocks,
          boundsOffset,
        );
        unionSplatBounds(cut.final.boundingBox, boundsBlocks, boundsOffset + 6);
      }
    }
  }
  for (const cut of cuts.values()) {
    cut.indices = new Uint32Array(cut.count);
    cut.offset = 0;
  }
  // Enumerate selected bits in Morton storage order without sorting the cut.
  // Unsorted stochastic draws traverse this order directly.
  for (let slot = 0; slot < pageCount; slot++) {
    const cut = pageCuts[slot];
    if (!cut) continue;
    const firstWord = (slot * RAD_PAGE_SIZE) / 32;
    for (let word = firstWord; word < firstWord + RAD_PAGE_SIZE / 32; word++) {
      let bits = selectedWords[word];
      while (bits) {
        const source = word * 32 + 31 - Math.clz32(bits & -bits);
        cut.indices[cut.offset++] = source;
        bits &= bits - 1;
      }
    }
  }
  return {
    cuts: Array.from(cuts, ([input, cut]) => {
      const { indices, centerOnlyBoundingBox, boundingBox, final } = cut;
      let finalCut;
      if (final && final.count < cut.count) {
        // The post-fade cut is a subset of the sorted target; omit outgoing group 3.
        finalCut = {
          indices: new Uint32Array(final.count),
          centerOnlyBoundingBox: final.centerOnlyBoundingBox,
          boundingBox: final.boundingBox,
        };
        let offset = 0;
        for (let index = 0; index < indices.length; index++) {
          const source = indices[index];
          const group =
            (opacityBlocks[source >>> 4] >>> ((source & 15) * 2)) & 3;
          if (group !== 3) finalCut.indices[offset++] = source;
        }
      }
      return {
        input,
        indices,
        centerOnlyBoundingBox,
        boundingBox,
        final: finalCut,
      };
    }),
    selectedPages,
    finalSelectedPages: fadeKinds & 2 ? finalSelectedPages : undefined,
    opacityBlocks,
    dirtyLayers,
    fadeKinds,
  };
}
