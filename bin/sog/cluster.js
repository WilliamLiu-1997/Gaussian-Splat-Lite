import { clusterRows } from "../rad/cluster.js";
import { HALF } from "../rad/math.js";

// A chunk's SH rows, as half bits, and weights in memory, read as floats:
// clustering reads every row in each pass, and converts a job's rows faster
// at once than value by value. Reading polls `check`, as paged arrays poll
// for cancellation.
class Rows {
  constructor({ sh, weights, dims }, check) {
    this.values = sh;
    this.weights = weights;
    this.Type = Float32Array;
    this.dims = dims;
    this.length = sh.length / dims;
    this.check = check;
  }

  weigh(base, count, weights) {
    weights.set(this.weights.subarray(base, base + count));
  }

  read(base, count, values, weights) {
    this.bands(base, count, values);
    this.weigh(base, count, weights);
  }

  bands(base, count, values) {
    const { dims } = this;
    this.check();
    const bits = this.values;
    const end = (base + count) * dims;
    for (let i = base * dims, at = 0; i < end; i++, at++)
      values[at] = HALF[bits[i]];
  }
}

// The SH entries of a chunk of `count` splats.
export const entries = (count, options) =>
  Math.min(
    count,
    262144,
    options.shCodebook ?? Math.max(1, Math.ceil(count / 8)),
  );

// Clusters a chunk's SH on this thread, in memory: the entries, `count` rows
// of `dims` coefficients, and each splat's label.
export async function cluster(attributes, options, kernel, check) {
  const rows = new Rows(attributes, check);
  const { dims } = rows;
  // Some exporters advertise SH3/4 while every coefficient is zero.
  let empty = true;
  for (let i = 0; i < rows.values.length; i++) {
    if ((i & 65535) === 0) check();
    // Either zero: +0 or -0.
    if (rows.values[i] & 0x7fff) {
      empty = false;
      break;
    }
  }
  if (empty) {
    return {
      codes: new Float32Array(dims),
      labels: new Uint16Array(rows.length),
      count: 1,
    };
  }

  const count = entries(rows.length, options);
  if (count < rows.length) {
    const { codes, labels } = await clusterRows(
      rows,
      undefined,
      options.shIterations,
      kernel,
      count,
      check,
    );
    return { codes, labels: labels.values, count };
  }

  // An entry per row is already an exact codebook; no nearest search is needed.
  const labels = new (count <= 65536 ? Uint16Array : Uint32Array)(count);
  for (let i = 0; i < count; i++) labels[i] = i;
  // Without a mapping function: Float32Array.from() with one lists the
  // values on the heap first.
  const codes = new Float32Array(rows.values.length);
  for (let i = 0; i < codes.length; i++) codes[i] = HALF[rows.values[i]];
  return { codes, labels, count };
}
