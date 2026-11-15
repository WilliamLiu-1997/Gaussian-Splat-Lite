import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadCloud } from "../sog/voxel/cloud.js";
import { planSimplifyCloudVoxel } from "../sog/voxel/plan.js";
import { GroupMerger } from "./representative-merge.js";
import { collect, sharedBuffer } from "./storage.js";

// What a worker takes for blocks of `count` splats that merge into `target`:
// its inputs, two blocks' results and the planner's temporary arrays.
export const representativeJobBytes = (count, target) =>
  count * 272 + target * 260;

const arrays = (bytes, make) => {
  const buffer = sharedBuffer(bytes);
  let offset = 0;
  return make((length, Type = Float32Array) => {
    const view = new Type(buffer, offset, length);
    offset += view.byteLength;
    return view;
  });
};

// A block's records and the planner's arrays of them, which a worker uses
// again for its next block.
export const representativeInputs = (count, target) =>
  arrays(count * 124 + target * 4, (take) => ({
    records: take(count * 16),
    core: {
      positions: take(count * 3),
      opacity: take(count),
      rgb: take(count * 3),
      covariance: take(count * 6),
      radius: take(count),
      weight: take(count),
    },
    cursors: take(target, Uint32Array),
  }));

// A block's splats with their merge weights, and their groups: the rows of
// group `slot` are `rows` from offsets[slot] up to offsets[slot + 1], and
// merge into record `slot` of `merged`. Kept until the block is committed.
export const representativeResults = (count, target) =>
  arrays(count * 16 + target * 68 + 4, (take) => ({
    weights: take(count, Float64Array),
    indices: take(count, Uint32Array),
    rows: take(count, Uint32Array),
    offsets: take(target + 1, Uint32Array),
    merged: take(target * 16),
  }));

export function computeRepresentatives(
  { inputs, results, count, target },
  check,
) {
  const { records, core, cursors } = inputs;
  const { weights, rows, offsets, merged } = results;
  check();
  let assignment;
  if (target === 1) assignment = new Int32Array(count);
  else {
    const cloud = loadCloud(records, count, core, weights, false);
    assignment = planSimplifyCloudVoxel(cloud, target, check).assignment;
  }
  offsets.fill(0, 0, target + 1);
  for (let row = 0; row < count; row++) {
    if ((row & 4095) === 0) check();
    const slot = assignment[row];
    if (slot < 0 || slot >= target)
      throw new Error("Representative assignment has an unassigned splat");
    offsets[slot + 1]++;
  }
  for (let slot = 0; slot < target; slot++) {
    offsets[slot + 1] += offsets[slot];
    cursors[slot] = offsets[slot];
  }
  for (let row = 0; row < count; row++) {
    if ((row & 4095) === 0) check();
    rows[cursors[assignment[row]]++] = row;
  }
  const merger = new GroupMerger(records, weights, check);
  for (let slot = 0; slot < target; slot++) {
    check();
    const start = offsets[slot];
    const end = offsets[slot + 1];
    if (start === end) throw new Error("Representative group is empty");
    merged.set(merger.run(rows, start, end), slot * 16);
  }
}

if (!isMainThread && workerData?.representative) {
  const { cancelled } = workerData;
  const check = () => {
    if (cancelled && Atomics.load(cancelled, 0))
      throw new Error("Conversion cancelled");
  };
  parentPort.on("message", (job) => {
    computeRepresentatives(job, check);
    collect();
    parentPort.postMessage(true);
  });
}
