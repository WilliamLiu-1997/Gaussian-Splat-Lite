import type { SplatExtra } from "./defines";

export const SH_KEYS = ["sh1", "sh2", "sh3a", "sh3b"] as const;
export const SH_ARRAY_COUNTS = [0, 1, 2, 4] as const;

/** Merge cached min XYZ / max XYZ values without decoding records. */
export function unionSplatBounds(
  target: Float32Array,
  source: Float32Array,
  offset = 0,
) {
  for (let axis = 0; axis < 3; axis++) {
    target[axis] = Math.min(target[axis], source[offset + axis]);
    target[axis + 3] = Math.max(target[axis + 3], source[offset + axis + 3]);
  }
}

export function resetSplatBounds(bounds: Float32Array) {
  bounds.fill(Number.POSITIVE_INFINITY, 0, 3);
  bounds.fill(Number.NEGATIVE_INFINITY, 3, 6);
}

export function getSplatShDegree(extra: SplatExtra) {
  return !extra.sh1 ? 0 : !extra.sh2 ? 1 : !extra.sh3a || !extra.sh3b ? 2 : 3;
}

/** Packed texture storage; capacity includes padding, but excludes sort centers. */
export function getSplatTextureBytes(capacity: number, numSh: number) {
  return capacity * (2 + SH_ARRAY_COUNTS[numSh]) * 16;
}

/** Retained CPU arrays, including sort centers and extra attribute buffers. */
export function getSplatByteLength(data: {
  splatArrays: readonly Uint32Array[];
  sortCenters?: Float32Array;
  sourceIds?: Uint32Array;
  centerOnlyBoundingBox?: Float32Array;
  boundingBox?: Float32Array;
  extra: SplatExtra;
}) {
  let bytes =
    (data.sortCenters?.byteLength ?? 0) +
    (data.sourceIds?.byteLength ?? 0) +
    (data.centerOnlyBoundingBox?.byteLength ?? 0) +
    (data.boundingBox?.byteLength ?? 0);
  for (const array of data.splatArrays) bytes += array.byteLength;
  for (const array of Object.values(data.extra))
    bytes += array?.byteLength ?? 0;
  return bytes;
}
