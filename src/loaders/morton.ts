import { morton_reorder } from "gaussian-splat-rs";
import type { ReorderedSplatResult, SplatResult } from "../data/defines";
import { SH_KEYS } from "../data/splatData";

/** Reorder packed attributes together and retain their original source indices. */
export function reorderSplats(
  data: SplatResult,
  boundsBlocks?: Float32Array,
): asserts data is ReorderedSplatResult {
  const { numSplats, splatArrays, sortCenters, sourceIds } = data;
  const centerBounds = new Float32Array(6);
  const bounds = new Float32Array(6);
  const arrays = [...splatArrays];
  for (const key of SH_KEYS) {
    const array = data.extra[key];
    if (array) arrays.push(array);
  }
  const order = morton_reorder(
    numSplats,
    arrays,
    sortCenters
      ? new Uint32Array(
          sortCenters.buffer,
          sortCenters.byteOffset,
          sortCenters.length,
        )
      : undefined,
    sourceIds,
    centerBounds,
    bounds,
    boundsBlocks,
  );
  data.sourceIds = order;
  data.centerOnlyBoundingBox = centerBounds;
  data.boundingBox = bounds;
}

/** Restore packed chunk file order bit for bit; discard unused sort centers. */
export function restoreSplatOrder(data: SplatResult) {
  const { numSplats, splatArrays, sourceIds } = data;
  data.sortCenters = undefined;
  if (!sourceIds) return;
  const order = invertSplatOrder(sourceIds.subarray(0, numSplats));
  const [splat0, splat1] = splatArrays;
  const scratch = new Uint32Array(numSplats * 4);
  const permute = (array: Uint32Array) => {
    for (let i = 0; i < numSplats; i++) {
      const source = order[i] * 4;
      for (let component = 0; component < 4; component++)
        scratch[i * 4 + component] = array[source + component];
    }
    array.set(scratch);
  };
  permute(splat0);
  permute(splat1);
  for (const key of SH_KEYS) {
    const array = data.extra[key];
    if (array) permute(array);
  }
  data.sourceIds = undefined;
}

/** Original index to storage index; chunk ranges require a complete permutation. */
export function invertSplatOrder(order: Uint32Array) {
  const inverse = new Uint32Array(order.length).fill(0xffffffff);
  for (let i = 0; i < order.length; i++) {
    const source = order[i];
    if (source >= order.length || inverse[source] !== 0xffffffff)
      throw new Error("Source IDs must form a complete chunk permutation");
    inverse[source] = i;
  }
  return inverse;
}
