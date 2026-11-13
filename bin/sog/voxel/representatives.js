import {
  REP_REACH_STRIDE,
  REP_REACH_VARIANCE,
  REP_TERMS_COV,
  REP_TERMS_LOG_DET,
  REP_TERMS_RGB,
  REP_TERMS_STRIDE,
} from "./assignment.js";
import { candidateDistanceFromLog, gaussianLogSimilarity } from "./metrics.js";

function representativeIndexForGroupRange(
  cloud,
  groupIndices,
  start,
  end,
  weights,
  radii,
  covarianceTerms,
  rgb,
  candidateLimit,
  check,
) {
  const pos = cloud.positions;
  const count = end - start;
  let fallback = -1;
  let fallbackWeight = Number.NEGATIVE_INFINITY;
  let fallbackRadius = Number.NEGATIVE_INFINITY;
  let totalWeight = 0.0;

  for (let p = start; p < end; p++) {
    if ((p & 4095) === 0) check();
    const idx = groupIndices[p];
    const rawWeight = weights[idx];
    const w = Number.isFinite(rawWeight) ? Math.max(rawWeight, 1e-12) : 1e-12;
    const radius = Number.isFinite(radii[idx])
      ? radii[idx]
      : Number.NEGATIVE_INFINITY;
    totalWeight += w;
    if (
      fallback < 0 ||
      w > fallbackWeight + 1e-12 ||
      (Math.abs(w - fallbackWeight) <= 1e-12 &&
        (radius > fallbackRadius + 1e-12 ||
          (Math.abs(radius - fallbackRadius) <= 1e-12 && idx > fallback)))
    ) {
      fallback = idx;
      fallbackWeight = w;
      fallbackRadius = radius;
    }
  }

  if (count === 1) {
    return fallback;
  }
  if (!Number.isFinite(totalWeight) || totalWeight <= 0.0) {
    return fallback;
  }

  let rep = fallback;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestMedoidCost = Number.POSITIVE_INFINITY;
  let bestWeight = fallbackWeight;
  let bestRadius = fallbackRadius;
  const invTotalWeight = 1.0 / totalWeight;
  const candidateCount = Math.min(count, candidateLimit);
  const sampled = candidateCount < count;
  let comparisons = 0;
  for (let p = 0; p < candidateCount; p++) {
    let idx;
    if (!sampled) idx = groupIndices[start + p];
    else if (p === 0) idx = fallback;
    else {
      const offset = Math.floor(((p - 0.5) * count) / (candidateCount - 1));
      idx = groupIndices[start + offset];
      if (idx === fallback) continue;
    }
    const radius = Number.isFinite(radii[idx])
      ? radii[idx]
      : Number.NEGATIVE_INFINITY;
    const rawWeight = weights[idx];
    const w = Number.isFinite(rawWeight) ? Math.max(rawWeight, 1e-12) : 1e-12;
    let cost = 0.0;
    for (let q = start; q < end; q++) {
      if ((comparisons++ & 4095) === 0) check();
      const other = groupIndices[q];
      const otherRawWeight = weights[other];
      const otherWeight = Number.isFinite(otherRawWeight)
        ? Math.max(otherRawWeight, 1e-12)
        : 1e-12;
      const logSimilarity = gaussianLogSimilarity(
        covarianceTerms,
        pos,
        rgb,
        idx,
        other,
      );
      cost += otherWeight * candidateDistanceFromLog(logSimilarity);
      if (cost * invTotalWeight > (bestCost + 1e-12) * w) {
        break;
      }
    }
    const medoidCost = cost * invTotalWeight;
    const weightedCost = medoidCost / w;
    if (
      weightedCost < bestCost - 1e-12 ||
      (Math.abs(weightedCost - bestCost) <= 1e-12 &&
        (medoidCost < bestMedoidCost - 1e-12 ||
          (Math.abs(medoidCost - bestMedoidCost) <= 1e-12 &&
            (w > bestWeight + 1e-12 ||
              (Math.abs(w - bestWeight) <= 1e-12 &&
                (radius > bestRadius + 1e-12 ||
                  (Math.abs(radius - bestRadius) <= 1e-12 && idx > rep)))))))
    ) {
      rep = idx;
      bestCost = weightedCost;
      bestMedoidCost = medoidCost;
      bestWeight = w;
      bestRadius = radius;
    }
  }
  return rep;
}

function computeAdaptiveMaxRepsByGroup(
  groupIndices,
  groupOffsets,
  target,
  representativesPerVoxelTarget,
  weights,
) {
  const groupCount = groupOffsets.length - 1;
  const maxRepsByGroup = new Uint32Array(groupCount);
  const capacities = new Uint32Array(groupCount);
  const groupWeights = new Float64Array(groupCount);
  let capacityTotal = 0;

  for (let group = 0; group < groupCount; group++) {
    const start = groupOffsets[group];
    const end = groupOffsets[group + 1];
    const size = end - start;
    maxRepsByGroup[group] = 1;
    const capacity = size - 1;
    capacities[group] = capacity;
    capacityTotal += capacity;
    if (capacity <= 0) {
      continue;
    }

    let groupWeight = 0.0;
    for (let p = start; p < end; p++) {
      const row = groupIndices[p];
      const weight = Number.isFinite(weights[row])
        ? Math.max(weights[row], 0.0)
        : 0.0;
      groupWeight += weight;
    }
    if (Number.isFinite(groupWeight) && groupWeight > 0.0) {
      groupWeights[group] = groupWeight;
    }
  }

  const averageBudget = Math.max(
    groupCount,
    groupCount * representativesPerVoxelTarget,
  );
  const localBudget = Math.min(
    target,
    groupCount + capacityTotal,
    averageBudget,
  );
  let remaining = Math.max(0, localBudget - groupCount);
  if (remaining <= 0 || capacityTotal <= 0) {
    return maxRepsByGroup;
  }

  let totalScore = 0.0;
  for (let group = 0; group < groupCount; group++) {
    if (capacities[group] > 0) {
      totalScore += groupWeights[group];
    }
  }
  const useCapacityFallback = !Number.isFinite(totalScore) || totalScore <= 0.0;
  if (useCapacityFallback) {
    totalScore = capacityTotal;
  }

  const exactExtras = new Float64Array(groupCount);
  const order = [];
  let allocated = 0;
  for (let group = 0; group < groupCount; group++) {
    const capacity = capacities[group];
    if (capacity <= 0) {
      continue;
    }
    const score = useCapacityFallback ? capacity : groupWeights[group];
    if (!Number.isFinite(score) || score <= 0.0) {
      continue;
    }

    const exact = (remaining * score) / totalScore;
    const extra = Math.min(capacity, Math.floor(exact));
    exactExtras[group] = exact;
    maxRepsByGroup[group] += extra;
    allocated += extra;
    if (extra < capacity) {
      order.push(group);
    }
  }

  remaining -= allocated;
  order.sort((a, b) => {
    const aRemainder = exactExtras[a] - (maxRepsByGroup[a] - 1);
    const bRemainder = exactExtras[b] - (maxRepsByGroup[b] - 1);
    if (aRemainder !== bRemainder) {
      return bRemainder - aRemainder;
    }
    const aScore = useCapacityFallback ? capacities[a] : groupWeights[a];
    const bScore = useCapacityFallback ? capacities[b] : groupWeights[b];
    if (aScore !== bScore) {
      return bScore - aScore;
    }
    const aCapacity = capacities[a] - (maxRepsByGroup[a] - 1);
    const bCapacity = capacities[b] - (maxRepsByGroup[b] - 1);
    if (aCapacity !== bCapacity) {
      return bCapacity - aCapacity;
    }
    return a - b;
  });

  while (remaining > 0 && order.length > 0) {
    let wrote = 0;
    for (let i = 0; i < order.length && remaining > 0; i++) {
      const group = order[i];
      if (maxRepsByGroup[group] - 1 >= capacities[group]) {
        continue;
      }
      maxRepsByGroup[group] += 1;
      remaining -= 1;
      wrote += 1;
    }
    if (wrote === 0) {
      break;
    }
  }

  return maxRepsByGroup;
}

// Lays out each group's representatives side by side for the final
// assignment, see assignRowsToNeighborGroupsRgbCov(): the largest variance
// first, with the output slot and the rank among the group's representatives
// of each, and the boxes of their centers and colors.
function buildRepGroupBounds(groupReps, selected, pos, rgb, covarianceTerms) {
  const groupCount = groupReps.length;
  const covariance = covarianceTerms.components;
  const logDetQuarter = covarianceTerms.logDetQuarter;
  const maxVariance = covarianceTerms.maxVariance;
  const posMin = new Float32Array(groupCount * 3);
  const posMax = new Float32Array(groupCount * 3);
  const rgbMin = new Float32Array(groupCount * 3);
  const rgbMax = new Float32Array(groupCount * 3);
  const repStarts = new Uint32Array(groupCount + 1);
  const repSlots = new Int32Array(selected.length);
  const repRanks = new Uint32Array(selected.length);
  const repReach = new Float32Array(selected.length * REP_REACH_STRIDE);
  const repTerms = new Float32Array(selected.length * REP_TERMS_STRIDE);
  let rep = 0;

  for (let group = 0; group < groupCount; group++) {
    const base3 = group * 3;
    posMin[base3 + 0] = Number.POSITIVE_INFINITY;
    posMin[base3 + 1] = Number.POSITIVE_INFINITY;
    posMin[base3 + 2] = Number.POSITIVE_INFINITY;
    rgbMin[base3 + 0] = Number.POSITIVE_INFINITY;
    rgbMin[base3 + 1] = Number.POSITIVE_INFINITY;
    rgbMin[base3 + 2] = Number.POSITIVE_INFINITY;
    posMax[base3 + 0] = Number.NEGATIVE_INFINITY;
    posMax[base3 + 1] = Number.NEGATIVE_INFINITY;
    posMax[base3 + 2] = Number.NEGATIVE_INFINITY;
    rgbMax[base3 + 0] = Number.NEGATIVE_INFINITY;
    rgbMax[base3 + 1] = Number.NEGATIVE_INFINITY;
    rgbMax[base3 + 2] = Number.NEGATIVE_INFINITY;
    repStarts[group] = rep;

    const reps = groupReps[group];
    const ranks = Array.from(reps.keys()).sort(
      (a, b) =>
        maxVariance[selected[reps[b]]] - maxVariance[selected[reps[a]]] ||
        a - b,
    );
    for (let i = 0; i < ranks.length; i++) {
      const slot = reps[ranks[i]];
      const row = selected[slot];
      const row3 = row * 3;
      const row6 = row * 6;
      repSlots[rep] = slot;
      repRanks[rep] = ranks[i];
      const reach = rep * REP_REACH_STRIDE;
      const px = pos[row3 + 0];
      const py = pos[row3 + 1];
      const pz = pos[row3 + 2];
      repReach[reach + 0] = px;
      repReach[reach + 1] = py;
      repReach[reach + 2] = pz;
      repReach[reach + REP_REACH_VARIANCE] = maxVariance[row];
      if (px < posMin[base3 + 0]) posMin[base3 + 0] = px;
      if (py < posMin[base3 + 1]) posMin[base3 + 1] = py;
      if (pz < posMin[base3 + 2]) posMin[base3 + 2] = pz;
      if (px > posMax[base3 + 0]) posMax[base3 + 0] = px;
      if (py > posMax[base3 + 1]) posMax[base3 + 1] = py;
      if (pz > posMax[base3 + 2]) posMax[base3 + 2] = pz;

      const terms = rep * REP_TERMS_STRIDE;
      const rr = rgb[row3 + 0];
      const rg = rgb[row3 + 1];
      const rb = rgb[row3 + 2];
      repTerms[terms + REP_TERMS_RGB + 0] = rr;
      repTerms[terms + REP_TERMS_RGB + 1] = rg;
      repTerms[terms + REP_TERMS_RGB + 2] = rb;
      if (rr < rgbMin[base3 + 0]) rgbMin[base3 + 0] = rr;
      if (rg < rgbMin[base3 + 1]) rgbMin[base3 + 1] = rg;
      if (rb < rgbMin[base3 + 2]) rgbMin[base3 + 2] = rb;
      if (rr > rgbMax[base3 + 0]) rgbMax[base3 + 0] = rr;
      if (rg > rgbMax[base3 + 1]) rgbMax[base3 + 1] = rg;
      if (rb > rgbMax[base3 + 2]) rgbMax[base3 + 2] = rb;

      for (let d = 0; d < 6; d++)
        repTerms[terms + REP_TERMS_COV + d] = covariance[row6 + d];
      repTerms[terms + REP_TERMS_LOG_DET] = logDetQuarter[row];
      rep++;
    }
  }
  repStarts[groupCount] = rep;

  return {
    posMin,
    posMax,
    rgbMin,
    rgbMax,
    repStarts,
    repSlots,
    repRanks,
    repReach,
    repTerms,
  };
}

export {
  representativeIndexForGroupRange,
  computeAdaptiveMaxRepsByGroup,
  buildRepGroupBounds,
};
