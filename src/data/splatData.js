export const SH_KEYS = ["sh1", "sh2", "sh3a", "sh3b"];
export const SH_ARRAY_COUNTS = [0, 1, 2, 4];
/** Merge cached min XYZ / max XYZ values without decoding records. */
export function unionSplatBounds(target, source, offset = 0) {
  for (let axis = 0; axis < 3; axis++) {
    target[axis] = Math.min(target[axis], source[offset + axis]);
    target[axis + 3] = Math.max(target[axis + 3], source[offset + axis + 3]);
  }
}
export function resetSplatBounds(bounds) {
  bounds.fill(Number.POSITIVE_INFINITY, 0, 3);
  bounds.fill(Number.NEGATIVE_INFINITY, 3, 6);
}
export function getSplatShDegree(extra) {
  return !extra.sh1 ? 0 : !extra.sh2 ? 1 : !extra.sh3a || !extra.sh3b ? 2 : 3;
}
/** Packed texture storage; capacity includes padding, but excludes sort centers. */
export function getSplatTextureBytes(capacity, numSh) {
  return capacity * (2 + SH_ARRAY_COUNTS[numSh]) * 16;
}
/** Retained CPU arrays, including sort centers and extra attribute buffers. */
export function getSplatByteLength(data) {
  let bytes =
    (data.sortCenters?.byteLength ?? 0) +
    (data.sourceIds?.byteLength ?? 0) +
    (data.centerOnlyBoundingBox?.byteLength ?? 0) +
    (data.boundingBox?.byteLength ?? 0) +
    (data.spatialBounds?.byteLength ?? 0);
  for (const array of data.splatArrays) bytes += array.byteLength;
  for (const array of Object.values(data.extra))
    bytes += array?.byteLength ?? 0;
  return bytes;
}
