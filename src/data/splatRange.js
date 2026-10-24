import { SH_KEYS } from "./splatData.js";
/** Copy a contiguous range of file-order records before spatial reordering. */
export function extractSplatRange(source, start, count) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > source.numSplats
  )
    throw new Error("Invalid Splat extraction range");
  const copy = (array) => array.slice(start * 4, (start + count) * 4);
  const extra = {};
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
