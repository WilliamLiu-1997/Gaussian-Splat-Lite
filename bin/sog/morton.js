function spread(value) {
  let v = value & 1023;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  return (v | (v << 2)) & 0x09249249;
}

// Writes the rows `indices` to `output` from `first`, in the order of the
// Morton codes of their centers, equal codes in the order of the rows.
// `centers` holds three values for each of `indices`, and `keys` has room
// for a number each.
export function sortMorton(indices, centers, keys, output, first) {
  const count = indices.length;
  const min = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++) {
      min[d] = Math.min(min[d], centers[i * 3 + d]);
      max[d] = Math.max(max[d], centers[i * 3 + d]);
    }
  // A code above its row in a 64-bit key: one sort of numbers orders both.
  const sorted = keys.subarray(0, count);
  const words = new Uint32Array(sorted.buffer, sorted.byteOffset, count * 2);
  for (let i = 0; i < count; i++) {
    let code = 0;
    for (let d = 0; d < 3; d++) {
      const value =
        max[d] === min[d]
          ? 0
          : Math.min(
              1023,
              Math.floor(
                ((centers[i * 3 + d] - min[d]) / (max[d] - min[d])) * 1024,
              ),
            );
      code |= spread(value) << d;
    }
    words[i * 2] = indices[i];
    words[i * 2 + 1] = code;
  }
  sorted.sort();
  for (let i = 0; i < count; i++) output[first + i] = words[i * 2];
}
