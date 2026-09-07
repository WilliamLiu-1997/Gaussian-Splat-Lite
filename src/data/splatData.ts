export const SH_KEYS = ["sh1", "sh2", "sh3a", "sh3b"] as const;
export const SH_ARRAY_COUNTS = [0, 1, 2, 4] as const;

export function getSplatShDegree(extra: Record<string, unknown>) {
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
  extra: Record<string, unknown>;
}) {
  let bytes = data.sortCenters?.byteLength ?? 0;
  for (const array of data.splatArrays) bytes += array.byteLength;
  for (const value of Object.values(data.extra)) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  return bytes;
}
