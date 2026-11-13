// The histogram of quantize(), kept from call to call: its 1.25 MiB would
// otherwise be garbage after every codebook. QUANTIZE_BYTES counts it.
const BINS = 65536;
export const QUANTIZE_BYTES = BINS * 20;
let histogram;

// Scalar codebooks remain CPU-only, including scale importance weighting.
export function quantize(values, importance = 0) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value))
      throw new Error("Cannot quantize a non-finite value");
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const codes = new Float32Array(256).fill(min);
  if (max === min) return codes;
  histogram ??= {
    weights: new Float64Array(BINS),
    sums: new Float64Array(BINS),
    used: new Uint32Array(BINS),
  };
  const { weights, sums } = histogram;
  weights.fill(0);
  sums.fill(0);
  const inverse = (BINS - 1) / (max - min);
  for (const value of values) {
    const bin = Math.round((value - min) * inverse);
    const weight = importance ? Math.exp(importance * (value - max)) : 1;
    weights[bin] += weight;
    sums[bin] += weight * value;
  }
  // The bins that hold values, in order.
  let used = 0;
  let total = 0;
  for (let i = 0; i < BINS; i++)
    if (weights[i]) {
      histogram.used[used++] = i;
      total += weights[i];
    }
  const points = histogram.used.subarray(0, used);
  let cumulative = 0;
  let cursor = 0;
  for (let c = 0; c < 256; c++) {
    const target = ((c + 0.5) / 256) * total;
    while (
      cursor < points.length - 1 &&
      cumulative + weights[points[cursor]] < target
    )
      cumulative += weights[points[cursor++]];
    const bin = points[cursor];
    codes[c] = sums[bin] / weights[bin];
  }
  const totals = new Float64Array(256);
  const centers = new Float64Array(256);
  for (let pass = 0; pass < 32; pass++) {
    totals.fill(0);
    centers.fill(0);
    let c = 0;
    for (const bin of points) {
      const value = sums[bin] / weights[bin];
      while (c < 255 && value > (codes[c] + codes[c + 1]) / 2) c++;
      totals[c] += weights[bin];
      centers[c] += sums[bin];
    }
    let changed = false;
    for (let i = 0; i < 256; i++)
      if (totals[i]) {
        const value = Math.fround(centers[i] / totals[i]);
        changed ||= value !== codes[i];
        codes[i] = value;
      }
    codes.sort();
    if (!changed) break;
  }
  return codes;
}

export function label(value, codes) {
  let low = 0;
  let high = 255;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (value > (codes[middle] + codes[middle + 1]) / 2) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function encodeRotation(record, output, offset) {
  let x = record[10];
  let y = record[11];
  let z = record[12];
  let w = record[13];
  const norm = Math.hypot(x, y, z, w);
  const sign = w < 0 ? -1 / norm : 1 / norm;
  x *= sign;
  y *= sign;
  z *= sign;
  w *= sign;
  const length = Math.hypot(x, y, z);
  const scale =
    length > 1e-12
      ? (Math.atan2(length, w) / length) * (2 / Math.PI)
      : 2 / Math.PI;
  output[offset] = Math.max(
    0,
    Math.min(255, Math.round(128 + 127 * x * scale)),
  );
  output[offset + 1] = Math.max(
    0,
    Math.min(255, Math.round(128 + 127 * y * scale)),
  );
  output[offset + 2] = Math.max(
    0,
    Math.min(255, Math.round(128 + 127 * z * scale)),
  );
}
