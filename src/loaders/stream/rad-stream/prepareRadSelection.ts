import type {
  RadPreparedSelection,
  RadSelectionSnapshot,
} from "../../../data/RadPagedSplats";
import { SPLAT_BOUNDS_BLOCK_SIZE } from "../../../data/defines";
import { resetSplatBounds, unionSplatBounds } from "../../../data/splatData";
import type { RadStreamSelection } from "./radFade";
import type { RadLodChunk } from "./radLod";

export type RadSelectionChunk = Pick<
  RadLodChunk,
  "sourceToStorage" | "boundsBlocks"
>;

/** The scheduler snapshots and pins resident pages before dispatching this work. */
export function prepareRadSelection(
  {
    selection,
    pools,
  }: { selection: RadStreamSelection; pools: RadSelectionSnapshot[] },
  chunks: ReadonlyMap<number, RadSelectionChunk>,
) {
  const { fade, ...target } = selection;
  const indices = fade?.indices ?? selection.indices;
  return {
    selection: target,
    fade: !!fade,
    pools: pools.map((pool) => preparePool(indices, fade?.fades, pool, chunks)),
  };
}

export type RadSelectionPreparation = ReturnType<typeof prepareRadSelection>;

function preparePool(
  indices: Uint32Array,
  fades: Uint8Array | undefined,
  { pageCount, opacityBlocks, ranges }: RadSelectionSnapshot,
  chunks: ReadonlyMap<number, RadSelectionChunk>,
): RadPreparedSelection {
  const count = ranges.reduce(
    (count, { start, end }) => count + end - start,
    0,
  );
  const target = new Uint32Array(count);
  const selectedPages = new Uint32Array(pageCount);
  const dirtyLayers = new Uint8Array(pageCount);
  // Flags record current (1) and post-fade (2) block membership.
  const blockFlags = new Uint8Array(
    opacityBlocks.length / SPLAT_BOUNDS_BLOCK_SIZE,
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
  let offset = 0;
  let finalCount = 0;
  let fadeKinds = 0;
  for (const {
    start,
    end,
    slot,
    pageStart,
    chunkIndex,
    sourceBase,
  } of ranges) {
    const chunk = chunks.get(chunkIndex);
    if (!chunk) throw new Error("RAD selection references a retired chunk");
    const { sourceToStorage: order, boundsBlocks } = chunk;
    selectedPages[slot] = end - start;
    const selectedBlocks: number[] = [];
    for (let index = start; index < end; index++) {
      const source = pageStart + order[indices[index] - sourceBase];
      const fade = fades?.[index] ?? 0;
      target[offset++] = source;
      const block = Math.floor(source / SPLAT_BOUNDS_BLOCK_SIZE);
      if (!blockFlags[block]) {
        blockFlags[block] = 1;
        selectedBlocks.push(block);
      }
      fadeKinds |= fade;
      if (opacityBlocks[source] !== fade + 1) {
        opacityBlocks[source] = fade + 1;
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
  // Traverse the Morton storage sequentially in stochastic mode. Sorted mode
  // still obtains its depth order from these same selected records.
  target.sort();
  let finalSelection: RadPreparedSelection["final"];
  if (final && fadeKinds & 2) {
    // The post-fade cut is a subset of the sorted target; omit outgoing group 3.
    const indices = new Uint32Array(finalCount);
    let offset = 0;
    for (const source of target)
      if (opacityBlocks[source] !== 3) indices[offset++] = source;
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
