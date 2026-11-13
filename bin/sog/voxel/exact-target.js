import { gaussianLogSimilarity } from "./metrics.js";

function priority(a, b) {
  return (
    a.weight / a.quota - b.weight / b.quota ||
    (a.end - a.start) / a.quota - (b.end - b.start) / b.quota ||
    b.slot - a.slot
  );
}

function siftDown(heap, root) {
  let index = root;
  const group = heap[index];
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && priority(heap[child + 1], heap[child]) > 0)
      child++;
    if (priority(group, heap[child]) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = group;
}

export function fillExactTarget(
  cloud,
  selected,
  assignment,
  target,
  covarianceTerms,
  check,
) {
  if (selected.length === target) return;
  const { length: count, positions, rgb, mergeWeight: weights } = cloud;
  const offsets = new Uint32Array(selected.length + 1);
  const rows = new Uint32Array(count);
  const scratch = new Uint32Array(count);
  // Each member's similarity to its group's representative, by place.
  const toOriginal = new Float64Array(count);
  for (let row = 0; row < count; row++) {
    if ((row & 4095) === 0) check();
    const weight = weights[row];
    if (!(weight > 0) || !Number.isFinite(weight))
      throw new Error("Invalid splat merge weight");
    offsets[assignment[row] + 1]++;
  }
  for (let slot = 0; slot < selected.length; slot++)
    offsets[slot + 1] += offsets[slot];
  const cursors = offsets.slice();
  for (let row = 0; row < count; row++) rows[cursors[assignment[row]]++] = row;

  const groups = [];
  const heap = [];
  for (let slot = 0; slot < selected.length; slot++) {
    check();
    const start = offsets[slot];
    const end = offsets[slot + 1];
    const members = rows.subarray(start, end);
    let weight = 0;
    for (const row of members) weight += weights[row];
    const group = { slot, start, end, weight, quota: 1 };
    groups.push(group);
    if (end - start > 1) heap.push(group);
  }
  for (let i = (heap.length >>> 1) - 1; i >= 0; i--) siftDown(heap, i);
  for (let size = selected.length; size < target; size++) {
    if ((size & 4095) === 0) check();
    if (!heap.length)
      throw new Error("Voxel selection missed its target count");
    const group = heap[0];
    group.quota++;
    if (group.quota === group.end - group.start) {
      const last = heap.pop();
      if (heap.length) heap[0] = last;
    }
    if (heap.length) siftDown(heap, 0);
  }
  heap.length = 0;
  for (const { start, end, quota } of groups) {
    if (quota === 1) continue;
    check();
    rows.subarray(start, end).sort((a, b) => weights[b] - weights[a] || a - b);
  }

  const similarity = (a, b) =>
    gaussianLogSimilarity(covarianceTerms, positions, rgb, a, b);
  while (groups.length) {
    const { slot, start, end, quota } = groups.pop();
    if (quota === 1) continue;
    check();
    const original = selected[slot];
    let added = -1;
    let leastSimilarity = Number.POSITIVE_INFINITY;
    for (let p = start; p < end; p++) {
      if ((p & 4095) === 0) check();
      const row = rows[p];
      if (row === original) continue;
      const score = similarity(row, original);
      toOriginal[p] = score;
      if (added < 0 || score < leastSimilarity) {
        added = row;
        leastSimilarity = score;
      }
    }

    const newSlot = selected.length;
    selected.push(added);
    const leftQuota = Math.ceil(quota / 2);
    const rightQuota = quota - leftQuota;
    let leftWeight = weights[original];
    let rightWeight = weights[added];
    let left = start;
    let right = end;
    scratch[left++] = original;
    scratch[--right] = added;
    assignment[added] = newSlot;
    for (let p = start; p < end; p++) {
      if ((p & 4095) === 0) check();
      const row = rows[p];
      if (row === original || row === added) continue;
      let keep;
      // Each side needs enough members to fill its remaining output slots.
      if (left === end - rightQuota) keep = false;
      else if (right === start + leftQuota) keep = true;
      else {
        const a = toOriginal[p];
        const b = similarity(row, added);
        keep =
          a > b ||
          (a === b && leftWeight / leftQuota <= rightWeight / rightQuota);
      }
      assignment[row] = keep ? slot : newSlot;
      if (keep) {
        leftWeight += weights[row];
        scratch[left++] = row;
      } else {
        rightWeight += weights[row];
        scratch[--right] = row;
      }
    }
    // Preserve non-representative members' weight order for later splits.
    scratch.subarray(right, end).reverse();
    rows.set(scratch.subarray(start, end), start);
    groups.push(
      { slot, start, end: left, quota: leftQuota },
      { slot: newSlot, start: right, end, quota: rightQuota },
    );
  }
  if (selected.length !== target)
    throw new Error("Voxel selection missed its target count");
}
