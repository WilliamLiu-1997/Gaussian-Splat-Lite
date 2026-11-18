import {
  DIRECT_SCAN_LIMIT,
  NOVELTY_ROOT,
  SEARCH_RADIUS_FEATURES,
} from "../lod-config.js";
import { CandidateHeap } from "./candidate-heap.js";
import { logSimilarityFor } from "./metrics.js";
import { representativeIndexForGroupRange } from "./representatives.js";

export function selectByNovelty(
  cloud,
  target,
  terms,
  groupsFor,
  offsets,
  indices,
  candidateLimit,
  check,
  reportSeeds,
  reportSelection,
) {
  const { length: count, weight, radius } = cloud;
  const selected = [];
  const assignment = new Int32Array(count).fill(-1);
  const rowGroup = new Uint32Array(count);
  const groupSlots = Array.from({ length: offsets.length - 1 }, () => []);
  for (let group = 0; group < groupSlots.length; group++) {
    const start = offsets[group];
    const end = offsets[group + 1];
    const row = representativeIndexForGroupRange(
      cloud,
      indices,
      start,
      end,
      terms,
      candidateLimit,
      check,
    );
    assignment[row] = selected.length;
    groupSlots[group].push(selected.length);
    selected.push(row);
    reportSeeds?.(selected.length);
    for (let p = start; p < end; p++) rowGroup[indices[p]] = group;
  }

  const remaining = new Int32Array(count - selected.length);
  let used = 0;
  for (let row = 0; row < count; row++)
    if (assignment[row] < 0) remaining[used++] = row;

  const checkedSlots = new Uint32Array(count);
  const bestLog = new Float32Array(count).fill(Number.NEGATIVE_INFINITY);
  const priority = Float64Array.from(weight.subarray(0, count));
  const heap = new CandidateHeap(remaining, (a, b) => {
    if (priority[a] !== priority[b]) return priority[a] > priority[b];
    if (weight[a] !== weight[b]) return weight[a] > weight[b];
    if (bestLog[a] !== bestLog[b]) return bestLog[a] < bestLog[b];
    return radius[a] !== radius[b] ? radius[a] > radius[b] : a > b;
  });

  function refresh(row) {
    const start = checkedSlots[row];
    const reach = SEARCH_RADIUS_FEATURES * cloud.featureSize[row];
    const score = logSimilarityFor(cloud, terms, row, reach);
    let best = bestLog[row];
    // A short tail is cheaper to check directly than through the spatial index.
    if (selected.length - start <= DIRECT_SCAN_LIMIT) {
      for (let i = selected.length - 1; i >= start && best < 0; i--)
        best = Math.max(best, Math.fround(score(selected[i], best)));
    } else {
      for (const group of groupsFor(row, reach)) {
        const slots = groupSlots[group];
        for (let i = slots.length - 1; i >= 0 && slots[i] >= start; i--) {
          if ((i & 4095) === 0) check();
          best = Math.max(best, Math.fround(score(selected[slots[i]], best)));
          if (best === 0) break;
        }
        if (best === 0) break;
      }
    }
    checkedSlots[row] = selected.length;
    bestLog[row] = best;
    priority[row] = weight[row] * -Math.expm1(best / NOVELTY_ROOT);
  }

  let visits = 0;
  while (selected.length < target) {
    if ((visits++ & 1023) === 0) {
      check();
      reportSelection?.(selected.length - groupSlots.length);
    }
    const row = heap.rows[0];
    if (checkedSlots[row] < selected.length && bestLog[row] < 0) {
      refresh(row);
      heap.siftDown(0);
      if (heap.rows[0] !== row) continue;
    }
    heap.pop();
    assignment[row] = selected.length;
    groupSlots[rowGroup[row]].push(selected.length);
    selected.push(row);
  }
  return { selected, assignment, groupSlots };
}
