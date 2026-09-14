import type { SplatExtra, SplatResult } from "./defines";
import { SH_KEYS } from "./splatData";

/** Copy file-order records; the caller assigns source IDs after reordering. */
export function extractSplatRange(
  source: SplatResult,
  start: number,
  count: number,
): SplatResult {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > source.numSplats
  )
    throw new Error("Invalid Splat extraction range");
  const copy = (array: Uint32Array) =>
    array.slice(start * 4, (start + count) * 4);
  const extra: SplatExtra = {};
  if (count) {
    for (const key of SH_KEYS) {
      const array = source.extra[key];
      if (array) extra[key] = copy(array);
    }
  }
  return {
    numSplats: count,
    splatArrays: [copy(source.splatArrays[0]), copy(source.splatArrays[1])],
    extra,
  };
}
