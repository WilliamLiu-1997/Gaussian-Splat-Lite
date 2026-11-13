import { clusterRows } from "../rad/cluster.js";

// A chunk's SH rows and weights in memory; reading them polls `check`, as
// paged arrays poll for cancellation.
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
    values.set(this.values.subarray(base * dims, (base + count) * dims));
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
    return { codes, labels: labels.values, dims, count };
  }

  // An entry per row is already an exact codebook; no nearest search is needed.
  const labels = new (count <= 65536 ? Uint16Array : Uint32Array)(count);
  for (let i = 0; i < count; i++) labels[i] = i;
  return { codes: rows.values, labels, dims, count };
}
