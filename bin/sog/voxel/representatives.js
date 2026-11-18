import {
  REP_REACH_STRIDE,
  REP_REACH_VARIANCE,
  REP_TERMS_COV,
  REP_TERMS_LOG_DET,
  REP_TERMS_RGB,
  REP_TERMS_STRIDE,
} from "./assignment.js";
import { candidateDistanceFromLog, gaussianLogSimilarity } from "./metrics.js";

function sameGaussian(a, b, positions, rgb, terms) {
  for (let d = 0; d < 3; d++)
    if (
      positions[a * 3 + d] !== positions[b * 3 + d] ||
      rgb[a * 3 + d] !== rgb[b * 3 + d]
    )
      return false;
  for (let d = 0; d < 6; d++)
    if (terms.components[a * 6 + d] !== terms.components[b * 6 + d])
      return false;
  return terms.logDetQuarter[a] === terms.logDetQuarter[b];
}

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
  let cachedRow = -1;
  let cachedCost = 0;
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
    let cost;
    if (
      cachedRow >= 0 &&
      sameGaussian(idx, cachedRow, pos, rgb, covarianceTerms)
    ) {
      cost = cachedCost;
    } else {
      cost = 0;
      let q = start;
      for (; q < end; q++) {
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
        if (cost * invTotalWeight > (bestCost + 1e-12) * w) break;
      }
      // The sum depends only on position, color and covariance. Only a
      // complete sum is reusable; a pruned search is merely a lower bound.
      if (q === end) {
        cachedRow = idx;
        cachedCost = cost;
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

function allocateRepresentatives(groupIndices, groupOffsets, target, opacity) {
  const groupCount = groupOffsets.length - 1;
  const maxRepsByGroup = new Uint32Array(groupCount);
  const counts = new Uint32Array(groupCount);
  const weights = new Float64Array(groupCount);
  const quotas = new Float64Array(groupCount);
  const order = [];
  let budget = target;
  for (let group = 0; group < groupCount; group++) {
    const start = groupOffsets[group];
    const end = groupOffsets[group + 1];
    counts[group] = end - start;
    for (let p = start; p < end; p++) {
      const weight = opacity[groupIndices[p]];
      weights[group] += Number.isFinite(weight) ? Math.max(weight, 0) : 0;
    }
    if (!Number.isFinite(weights[group])) weights[group] = 0;
    order.push(group);
  }

  while (order.length > 0) {
    let totalWeight = 0;
    for (const group of order) totalWeight += weights[group];
    if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) {
      totalWeight = 0;
      for (const group of order) {
        weights[group] = counts[group] - 1;
        totalWeight += weights[group];
      }
      const extras = budget - order.length;
      for (const group of order)
        quotas[group] =
          1 + (totalWeight > 0 ? (extras * weights[group]) / totalWeight : 0);
      break;
    }

    let shortage = 0;
    let excess = 0;
    for (const group of order) {
      const exact = (budget * weights[group]) / totalWeight;
      quotas[group] = exact;
      shortage += Math.max(0, 1 - exact);
      excess += Math.max(0, exact - counts[group]);
    }
    if (shortage === excess) break;

    // Clamp only the bound that moves the total toward the budget.
    const fixMinimum = shortage > excess;
    let active = 0;
    for (const group of order) {
      if (fixMinimum ? quotas[group] < 1 : quotas[group] > counts[group]) {
        const count = fixMinimum ? 1 : counts[group];
        maxRepsByGroup[group] = count;
        budget -= count;
      } else {
        order[active++] = group;
      }
    }
    order.length = active;
  }

  let remaining = budget;
  let candidates = 0;
  for (const group of order) {
    const exact = Math.max(1, Math.min(counts[group], quotas[group]));
    const count = Math.floor(exact);
    maxRepsByGroup[group] = count;
    quotas[group] = exact - count;
    remaining -= count;
    if (count < counts[group]) order[candidates++] = group;
  }
  order.length = candidates;
  order.sort(
    (a, b) => quotas[b] - quotas[a] || weights[b] - weights[a] || a - b,
  );
  for (let i = 0; i < remaining; i++) maxRepsByGroup[order[i]]++;

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
  allocateRepresentatives,
  buildRepGroupBounds,
};
