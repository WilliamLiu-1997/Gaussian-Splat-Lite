import type {
  RadPreparedSelection,
  RadSelectionSnapshot,
} from "../../../data/RadPagedSplats";
import type { RadStreamSelection } from "./radFade";

/** The scheduler snapshots and pins resident pages before dispatching this work. */
export function prepareRadSelection({
  selection,
  pools,
}: { selection: RadStreamSelection; pools: RadSelectionSnapshot[] }) {
  const { fade, ...target } = selection;
  const indices = fade?.indices ?? selection.indices;
  return {
    selection: target,
    fade: !!fade,
    pools: pools.map((pool) => preparePool(indices, fade?.fades, pool)),
  };
}

export type RadSelectionPreparation = ReturnType<typeof prepareRadSelection>;

function preparePool(
  indices: Uint32Array,
  fades: Uint8Array | undefined,
  { pageCount, opacityBlocks, ranges }: RadSelectionSnapshot,
): RadPreparedSelection {
  const count = ranges.reduce(
    (count, { start, end }) => count + end - start,
    0,
  );
  const target = new Uint32Array(count);
  const selectedPages = new Uint32Array(pageCount);
  const dirtyLayers = new Uint8Array(pageCount);
  const final = fades
    ? { indices: new Uint32Array(count), selectedPages: selectedPages.slice() }
    : undefined;
  let offset = 0;
  let finalCount = 0;
  let fadeKinds = 0;
  for (const { start, end, slot, sourceOffset } of ranges) {
    selectedPages[slot] = end - start;
    for (let index = start; index < end; index++) {
      const source = indices[index] + sourceOffset;
      const fade = fades?.[index] ?? 0;
      target[offset++] = source;
      fadeKinds |= fade;
      if (opacityBlocks[source] !== fade + 1) {
        opacityBlocks[source] = fade + 1;
        dirtyLayers[slot] = 1;
      }
      if (final && fade !== 2) {
        final.indices[finalCount++] = source;
        final.selectedPages[slot]++;
      }
    }
  }
  if (final) final.indices = final.indices.subarray(0, finalCount);
  return {
    indices: target,
    selectedPages,
    opacityBlocks,
    dirtyLayers,
    fadeKinds,
    final: fadeKinds & 2 ? final : undefined,
  };
}
