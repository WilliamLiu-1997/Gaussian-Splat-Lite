import type { SplatResult } from "./defines";
import { getTextureSize } from "./textureLayout";

/** Copy owned records; compact ranges omit texture padding and sort centers. */
export function extractSplatRange(
  source: SplatResult,
  start: number,
  count: number,
  compact = false,
): SplatResult {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > source.numSplats
  )
    throw new Error("Invalid Splat extraction range");
  const capacity = count && !compact ? getTextureSize(count).maxSplats : count;
  const copy = (array: Uint32Array) => {
    const output = new Uint32Array(capacity * 4);
    output.set(array.subarray(start * 4, (start + count) * 4));
    return output;
  };
  let sortCenters = compact
    ? undefined
    : source.sortCenters?.slice(start * 3, (start + count) * 3);
  if (!compact && !sortCenters) {
    sortCenters = new Float32Array(count * 3);
    const [first, second] = source.splatArrays;
    const centers = new Float32Array(
      first.buffer,
      first.byteOffset,
      first.length,
    );
    for (let i = 0; i < count; i++) {
      const offset = (start + i) * 4;
      const disabled =
        second[offset + 1] >>> 16 === 0xfc00 &&
        second[offset + 2] === 0xfc00fc00;
      for (let axis = 0; axis < 3; axis++)
        sortCenters[i * 3 + axis] = disabled
          ? Number.NaN
          : centers[offset + axis];
    }
  }
  return {
    numSplats: count,
    splatArrays: [copy(source.splatArrays[0]), copy(source.splatArrays[1])],
    sortCenters,
    extra: Object.fromEntries(
      Object.entries(count ? source.extra : {}).flatMap(([key, value]) =>
        value ? [[key, copy(value)]] : [],
      ),
    ),
  };
}
