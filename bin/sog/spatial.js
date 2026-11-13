const BINS = 256;

export function boundsOf(rows, order, start, count) {
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
  const record = new Float32Array(16);
  for (let i = start; i < start + count; i++) {
    rows.read(order.get(i), record);
    for (let d = 0; d < 3; d++) {
      min[d] = Math.min(min[d], record[d]);
      max[d] = Math.max(max[d], record[d]);
    }
  }
  return { min, max };
}

function measures(min, max, epsilon) {
  const x = Math.max(epsilon, max[0] - min[0]);
  const y = Math.max(epsilon, max[1] - min[1]);
  const z = Math.max(epsilon, max[2] - min[2]);
  return [2 * (x * y + x * z + y * z), x * y * z];
}

function better(a, b) {
  if (!b) return true;
  for (let i = 0; i < a.length; i++) {
    const tolerance =
      1e-12 * Math.max(Math.abs(a[i]), Math.abs(b[i]), Number.MIN_VALUE);
    if (a[i] < b[i] - tolerance) return true;
    if (a[i] > b[i] + tolerance) return false;
  }
  return false;
}

// The bins of a node's centers along each axis, and the cut that they give.
export class Cut {
  constructor(bound) {
    this.bound = bound;
    this.ext = bound.max.map((v, d) => v - bound.min[d]);
    this.longest = Math.max(...this.ext);
    this.epsilon = Math.max(1e-9, this.longest * 1e-9);
    this.sizes = new Uint32Array(3 * BINS);
    this.mins = new Float64Array(9 * BINS).fill(Number.POSITIVE_INFINITY);
    this.maxs = new Float64Array(9 * BINS).fill(Number.NEGATIVE_INFINITY);
    this.axis = -1;
    this.value = 0;
  }

  // Adds the center at `at` of `values`.
  add(values, at = 0) {
    const { bound, ext, epsilon, sizes, mins, maxs } = this;
    for (let axis = 0; axis < 3; axis++) {
      if (ext[axis] <= epsilon) continue;
      const bin =
        axis * BINS +
        Math.min(
          BINS - 1,
          Math.floor(
            ((values[at + axis] - bound.min[axis]) / ext[axis]) * BINS,
          ),
        );
      sizes[bin]++;
      for (let d = 0; d < 3; d++) {
        mins[bin * 3 + d] = Math.min(mins[bin * 3 + d], values[at + d]);
        maxs[bin * 3 + d] = Math.max(maxs[bin * 3 + d], values[at + d]);
      }
    }
  }

  // Adds the bins of centers that another thread collected with the same
  // box: counts add up, and the smallest and largest stay so.
  merge({ sizes, mins, maxs }) {
    for (let i = 0; i < sizes.length; i++) this.sizes[i] += sizes[i];
    for (let i = 0; i < mins.length; i++) {
      this.mins[i] = Math.min(this.mins[i], mins[i]);
      this.maxs[i] = Math.max(this.maxs[i], maxs[i]);
    }
  }

  // Chooses the axis and the value that cut the `count` centers added, and
  // returns whether there is such a cut: there is none when they coincide.
  choose(count) {
    const { bound, ext, longest, epsilon, sizes, mins, maxs } = this;
    const [parentArea, parentVolume] = measures(bound.min, bound.max, epsilon);
    const parentCost = parentArea * count;
    let best;
    const suffixMin = new Float64Array(BINS * 3);
    const suffixMax = new Float64Array(BINS * 3);
    const suffixCount = new Uint32Array(BINS);
    for (let axis = 0; axis < 3; axis++) {
      if (ext[axis] <= epsilon) continue;
      // Cuts across shorter axes count for more.
      const aspect = Math.sqrt(longest / ext[axis]);
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
      let size = 0;
      for (let b = BINS - 1; b >= 0; b--) {
        const bin = axis * BINS + b;
        size += sizes[bin];
        suffixCount[b] = size;
        for (let d = 0; d < 3; d++) {
          min[d] = Math.min(min[d], mins[bin * 3 + d]);
          max[d] = Math.max(max[d], maxs[bin * 3 + d]);
          suffixMin[b * 3 + d] = min[d];
          suffixMax[b * 3 + d] = max[d];
        }
      }
      min.fill(Number.POSITIVE_INFINITY);
      max.fill(Number.NEGATIVE_INFINITY);
      size = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const bin = axis * BINS + b;
        size += sizes[bin];
        for (let d = 0; d < 3; d++) {
          min[d] = Math.min(min[d], mins[bin * 3 + d]);
          max[d] = Math.max(max[d], maxs[bin * 3 + d]);
        }
        const rightCount = suffixCount[b + 1];
        if (!size || !rightCount) continue;
        const offset = (b + 1) * 3;
        const [leftArea, leftVolume] = measures(min, max, epsilon);
        const [rightArea, rightVolume] = measures(
          suffixMin.subarray(offset, offset + 3),
          suffixMax.subarray(offset, offset + 3),
          epsilon,
        );
        const sah = leftArea * size + rightArea * rightCount;
        const volume = leftVolume + rightVolume;
        const score = (((sah / parentCost) * volume) / parentVolume) * aspect;
        const metrics = [
          score,
          volume,
          Math.max(leftVolume, rightVolume),
          sah,
          Math.max(leftArea * size, rightArea * rightCount),
          Math.abs(size - rightCount) / count,
          -ext[axis],
          axis,
        ];
        if (better(metrics, best)) {
          best = metrics;
          this.axis = axis;
          this.value = bound.min[axis] + (ext[axis] * (b + 1)) / BINS;
        }
      }
    }
    return this.axis >= 0;
  }
}

// Adds the centers of the `count` rows from `start` of `order` to `cut`.
export function binRange(rows, order, start, count, cut) {
  const record = new Float32Array(16);
  for (let i = start; i < start + count; i++) {
    rows.read(order.get(i), record);
    cut.add(record);
  }
}

// Moves the rows before the cut, of the `count` from `start` of `order`, to
// the front, and returns where the others start.
export function partRange(rows, order, start, count, axis, value) {
  const record = new Float32Array(16);
  let left = start;
  let right = start + count - 1;
  while (left <= right) {
    const index = order.get(left);
    rows.read(index, record);
    if (record[axis] < value) left++;
    else {
      order.set(left, order.get(right));
      order.set(right--, index);
    }
  }
  return left;
}

// Splits the `count` rows from `start` of `order` in two and returns where
// the second part starts. The parts do not depend on the order of the rows.
export function splitRange(
  rows,
  order,
  start,
  count,
  bound = boundsOf(rows, order, start, count),
) {
  const cut = new Cut(bound);
  binRange(rows, order, start, count, cut);
  // Coincident centers still need two nonempty groups to enforce the point
  // cap: the first half by row.
  if (!cut.choose(count)) {
    order.sort(start, count);
    return start + Math.floor(count / 2);
  }
  const middle = partRange(rows, order, start, count, cut.axis, cut.value);
  if (middle === start || middle === start + count)
    throw new Error("Spatial split produced an empty child");
  return middle;
}
