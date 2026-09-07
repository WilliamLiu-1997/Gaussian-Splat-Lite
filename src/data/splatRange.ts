import type { SplatResult } from "./defines";
import { getTextureSize } from "./textureLayout";

/** Copy owned, texture-padded records without depending on scene objects. */
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
  const capacity = count ? getTextureSize(count).maxSplats : 0;
  const copy = (array: Uint32Array) => {
    const output = new Uint32Array(capacity * 4);
    output.set(array.subarray(start * 4, (start + count) * 4));
    return output;
  };
  const sortCenters = source.sortCenters
    ? source.sortCenters.slice(start * 3, (start + count) * 3)
    : new Float32Array(count * 3);
  if (!source.sortCenters) {
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
        (second[offset + 2] & 0xffff) === 0xfc00 &&
        second[offset + 2] >>> 16 === 0xfc00;
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
