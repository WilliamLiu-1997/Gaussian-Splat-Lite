import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { HALF, halfBits, opacityRadius } from "../rad/math.js";
import { collect, sharedBuffer } from "../rad/storage.js";
import { SH_C0, SH_DIMS } from "./splats.js";
import {
  covarianceComponentsFromValuesWithScales,
  covarianceToScaleQuat,
  makeCovarianceToScaleQuatScratch,
} from "./voxel/covariance.js";
import {
  ellipsoidAreaFromScales,
  threeSigmaAabbBlendedRadiusFromExtents,
} from "./voxel/extents.js";
import { planSimplifyCloudVoxel } from "./voxel/plan.js";

// Memory that simplifying a block of `count` splats into `target` takes: its
// arrays, see blockArrays(), and the planner's.
export function blockBytes(count, target, dims) {
  return (count + target) * 256 + (count * 2 + target * 10) * dims;
}

// A thread's arrays for blocks of up to `count` splats that simplify into up
// to `target`: the splats, the simplified splats, and the working arrays
// whose sizes are known beforehand; SH as half bits, last, after the arrays
// of wider values. Like the cache's arenas, they lie in shared WebAssembly
// memory: the thread that simplifies a block shares them, and the memory
// returns to the system once collected, which freed heap memory does not on
// every platform.
export function blockArrays(count, target, maxSh) {
  const bands = SH_DIMS.slice(0, maxSh);
  const dims = bands.reduce((a, b) => a + b, 0);
  const bytes =
    (target * (12 + dims) + count) * 8 +
    (count * 31 + target * 16) * 4 +
    (count + target) * dims * 2;
  const buffer = sharedBuffer(bytes);
  let offset = 0;
  const take = (size, Type = Float32Array) => {
    const values = new Type(buffer, offset, size);
    offset += size * Type.BYTES_PER_ELEMENT;
    return values;
  };
  return {
    // The merge sums of each simplified splat; see merge().
    sums: take(target * (12 + dims), Float64Array),
    // The merge weight of each splat; see loadCore().
    mergeWeight: take(count, Float64Array),
    records: take(count * 16),
    merged: take(target * 16),
    // What the planner reads of the splats; see loadCore().
    core: {
      positions: take(count * 3),
      opacity: take(count),
      rgb: take(count * 3),
      covariance: take(count * 6),
      radius: take(count),
      weight: take(count),
    },
    sh: bands.map((size) => take(count * size, Uint16Array)),
    mergedSh: bands.map((size) => take(target * size, Uint16Array)),
  };
}

function representativeOpacityWeight(opacity) {
  return opacity <= 1 ? opacity : opacityRadius(opacity);
}

// Fills the planner's arrays of `core`, and the merge weights, opacity ×
// ellipsoid area, of the `count` splats in `records`.
function loadCore({ records, count, core, mergeWeight }) {
  const cloud = {
    ...core,
    length: count,
    minFeature: Number.POSITIVE_INFINITY,
    origin: [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
  };
  const covariance = new Float64Array(6);
  const scales = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    const row = i * 16;
    for (let d = 0; d < 3; d++) {
      cloud.positions[i * 3 + d] = records[row + d];
      cloud.rgb[i * 3 + d] = Math.max(
        0,
        Math.min(1, 0.5 + ((records[row + 4 + d] - 0.5) / SH_C0) * 0.15),
      );
      cloud.origin[d] = Math.min(cloud.origin[d], records[row + d]);
    }
    const opacity = records[row + 3];
    covarianceComponentsFromValuesWithScales(
      records[row + 7],
      records[row + 8],
      records[row + 9],
      records[row + 10],
      records[row + 11],
      records[row + 12],
      records[row + 13],
      covariance,
      0,
      scales,
    );
    for (let d = 0; d < 6; d++) cloud.covariance[i * 6 + d] = covariance[d];
    const maxScale = Math.max(scales[0], scales[1], scales[2]);
    const opacityWeight = representativeOpacityWeight(opacity);
    cloud.opacity[i] = opacity;
    cloud.weight[i] = maxScale * opacityWeight;
    cloud.minFeature = Math.min(
      cloud.minFeature,
      2 * maxScale * Math.max(1, opacityWeight),
    );
    // Use the double-precision variances before the planner regularizes them.
    cloud.radius[i] = threeSigmaAabbBlendedRadiusFromExtents(
      3.0 * Math.sqrt(Math.max(covariance[0], 1e-20)),
      3.0 * Math.sqrt(Math.max(covariance[3], 1e-20)),
      3.0 * Math.sqrt(Math.max(covariance[5], 1e-20)),
    );
    mergeWeight[i] =
      opacity * ellipsoidAreaFromScales(scales[0], scales[1], scales[2]);
  }
  return cloud;
}

function merge(block, plan) {
  const { count, maxSh, records, sh, merged, mergedSh } = block;
  const target = plan.selected.length;
  const dims = SH_DIMS.slice(0, maxSh).reduce((a, b) => a + b, 0);
  const stride = 12 + dims;
  const sums = block.sums.subarray(0, target * stride).fill(0);
  const weights = new Float64Array(target);
  // The splats of each slot.
  const members = new Uint32Array(target);
  const record = new Float32Array(16);
  const covariance = new Float64Array(6);
  for (let i = 0; i < count; i++) {
    const slot = plan.assignment[i];
    if (slot < 0 || slot >= target)
      throw new Error("Voxel assignment has an unassigned splat");
    members[slot]++;
  }
  for (let i = 0; i < count; i++) {
    const row = i * 16;
    const slot = plan.assignment[i];
    const weight = block.mergeWeight[i];
    // A splat that nothing merges into stays as it is, its SH too.
    if (members[slot] === 1) {
      if (!(weight > 0) || !Number.isFinite(weight))
        throw new Error("Invalid splat merge weight");
      for (let d = 0; d < 16; d++) merged[slot * 16 + d] = records[row + d];
      for (let band = 0; band < maxSh; band++) {
        const size = SH_DIMS[band];
        mergedSh[band].set(
          sh[band].subarray(i * size, (i + 1) * size),
          slot * size,
        );
      }
      continue;
    }
    covarianceComponentsFromValuesWithScales(
      records[row + 7],
      records[row + 8],
      records[row + 9],
      records[row + 10],
      records[row + 11],
      records[row + 12],
      records[row + 13],
      covariance,
    );
    const total = weights[slot] + weight;
    if (!(weight > 0) || !Number.isFinite(total))
      throw new Error("Invalid splat merge weight");
    const base = slot * stride;
    const dx = records[row] - sums[base];
    const dy = records[row + 1] - sums[base + 1];
    const dz = records[row + 2] - sums[base + 2];
    const alpha = weight / total;
    sums[base] += alpha * dx;
    sums[base + 1] += alpha * dy;
    sums[base + 2] += alpha * dz;
    const ex = records[row] - sums[base];
    const ey = records[row + 1] - sums[base + 1];
    const ez = records[row + 2] - sums[base + 2];
    sums[base + 3] += weight * (covariance[0] + dx * ex);
    sums[base + 4] += weight * (covariance[1] + dx * ey);
    sums[base + 5] += weight * (covariance[2] + dx * ez);
    sums[base + 6] += weight * (covariance[3] + dy * ey);
    sums[base + 7] += weight * (covariance[4] + dy * ez);
    sums[base + 8] += weight * (covariance[5] + dz * ez);
    for (let d = 0; d < 3; d++)
      sums[base + 9 + d] += weight * records[row + 4 + d];
    let offset = base + 12;
    for (let band = 0; band < maxSh; band++) {
      const values = sh[band];
      const end = (i + 1) * SH_DIMS[band];
      for (let d = i * SH_DIMS[band]; d < end; d++)
        sums[offset++] += weight * HALF[values[d]];
    }
    weights[slot] = total;
  }
  const scratch = makeCovarianceToScaleQuatScratch();
  for (let slot = 0; slot < target; slot++) {
    // The arrays hold an earlier block's splats where nothing is written.
    if (!members[slot]) throw new Error("Voxel selection has an empty slot");
    if (members[slot] === 1) continue;
    const base = slot * stride;
    // Blind data follows the selected representative, never an average of IDs.
    const selected = plan.selected[slot] * 16;
    record[14] = records[selected + 14];
    record[15] = records[selected + 15];
    const weight = weights[slot];
    for (let d = 0; d < 6; d++) covariance[d] = sums[base + 3 + d] / weight;
    covarianceToScaleQuat(...covariance, record, 7, record, 10, scratch);
    record[3] =
      weight /
      ellipsoidAreaFromScales(
        Math.exp(record[7]),
        Math.exp(record[8]),
        Math.exp(record[9]),
      );
    for (let d = 0; d < 3; d++) {
      record[d] = sums[base + d];
      record[4 + d] = sums[base + 9 + d] / weight;
    }
    for (let d = 0; d < 14; d++)
      if (!Number.isFinite(record[d]))
        throw new Error("Merged splat exceeds Float32 range");
    merged.set(record, slot * 16);
    let offset = base + 12;
    for (let band = 0; band < maxSh; band++) {
      const values = mergedSh[band];
      const end = (slot + 1) * SH_DIMS[band];
      for (let d = slot * SH_DIMS[band]; d < end; d++)
        values[d] = halfBits(sums[offset++] / weights[slot]);
    }
  }
}

// Fill the merge weights and select the block's single representative.
function loadWeights(records, count, mergeWeight) {
  let selected = 0;
  let bestWeight = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const row = i * 16;
    const opacity = records[row + 3];
    const sx = Math.exp(records[row + 7]);
    const sy = Math.exp(records[row + 8]);
    const sz = Math.exp(records[row + 9]);
    mergeWeight[i] = opacity * ellipsoidAreaFromScales(sx, sy, sz);
    const weight = representativeOpacityWeight(opacity) * Math.max(sx, sy, sz);
    if (weight > bestWeight) {
      bestWeight = weight;
      selected = i;
    }
  }
  return selected;
}

function simplifyVoxel(block, check) {
  const cloud = loadCore(block);
  const plan = planSimplifyCloudVoxel(cloud, block.target, check);
  if (plan.selected.length !== block.target)
    throw new Error("Voxel selection missed its target count");
  merge(block, plan);
  return plan.selected.length;
}

// Returns the number of rows written to merged and mergedSh.
export function simplifyBlock(block, check) {
  const { count, target, maxSh, records, sh, merged, mergedSh } = block;
  check();
  if (target === count) {
    merged.set(records.subarray(0, count * 16));
    for (let band = 0; band < maxSh; band++)
      mergedSh[band].set(sh[band].subarray(0, count * SH_DIMS[band]));
    return count;
  }
  if (target === 1) {
    const selected = loadWeights(records, count, block.mergeWeight);
    merge(block, { selected: [selected], assignment: new Int32Array(count) });
    return 1;
  }
  const written = simplifyVoxel(block, check);
  collect();
  return written;
}

if (!isMainThread && workerData?.simplifier) {
  const { cancelled } = workerData;
  const check = () => {
    if (cancelled && Atomics.load(cancelled, 0))
      throw new Error("Conversion cancelled");
  };
  parentPort.on("message", (block) => {
    parentPort.postMessage(simplifyBlock(block, check));
  });
}
