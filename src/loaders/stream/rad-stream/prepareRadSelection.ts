import type {
  RadPreparedSelection,
  RadSelectionSnapshot,
} from "../../../data/RadPagedSplats";
import type { RadStreamSelection } from "./radFade";

/** Inputs are owned snapshots; live render buffers stay on the main thread. */
export function prepareRadSelection({
  selection,
  pools,
}: { selection: RadStreamSelection; pools: RadSelectionSnapshot[] }) {
  const { fade, ...target } = selection;
  const indices = fade?.indices ?? selection.indices;
  if (fade && fade.fades.length !== indices.length)
    throw new Error("RAD fade map must match the selection length");
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
  { pageStride, pageOccupancy, opacityBlocks, ranges }: RadSelectionSnapshot,
): RadPreparedSelection {
  let count = 0;
  let previousEnd = 0;
  const slots = new Set<number>();
  for (const { start, end, slot, sourceOffset } of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(slot) ||
      !Number.isSafeInteger(sourceOffset) ||
      start < previousEnd ||
      end < start ||
      end > indices.length ||
      slot < 0 ||
      slot >= pageOccupancy.length ||
      pageOccupancy[slot] < 0 ||
      slots.has(slot)
    )
      throw new Error("Invalid RAD selection range");
    slots.add(slot);
    previousEnd = end;
    count += end - start;
  }
  if (count > opacityBlocks.length)
    throw new Error("RAD selection exceeds page pool capacity");
  const target = new Uint32Array(count);
  const selectedPages = new Uint32Array(pageOccupancy.length);
  const dirtyLayers = new Uint8Array(pageOccupancy.length);
  const final = fades
    ? { indices: new Uint32Array(count), selectedPages: selectedPages.slice() }
    : undefined;
  let offset = 0;
  let finalCount = 0;
  let fadeKinds = 0;
  for (const { start, end, slot, sourceOffset } of ranges) {
    const first = slot * pageStride;
    const last = first + pageOccupancy[slot];
    selectedPages[slot] = end - start;
    for (let index = start; index < end; index++) {
      const source = indices[index] + sourceOffset;
      const fade = fades?.[index] ?? 0;
      if (source < first || source >= last)
        throw new Error("RAD selection references an unloaded page or padding");
      if (fade > 2) throw new Error("Invalid RAD index fade kind");
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
