import { SEED_TIE_EPSILON } from "../lod-config.js";
import { logSimilarityFor } from "./metrics.js";

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

export function representativeIndexForGroupRange(
  cloud,
  groupIndices,
  start,
  end,
  covarianceTerms,
  candidateLimit,
  check,
) {
  const { positions: pos, weight: weights, radius: radii, rgb } = cloud;
  const count = end - start;
  let fallback = -1;
  let fallbackWeight = Number.NEGATIVE_INFINITY;
  let fallbackRadius = Number.NEGATIVE_INFINITY;
  let totalWeight = 0.0;

  for (let p = start; p < end; p++) {
    if ((p & 4095) === 0) check();
    const idx = groupIndices[p];
    const w = weights[idx];
    const radius = Number.isFinite(radii[idx])
      ? radii[idx]
      : Number.NEGATIVE_INFINITY;
    totalWeight += w;
    if (
      fallback < 0 ||
      w > fallbackWeight + SEED_TIE_EPSILON ||
      (Math.abs(w - fallbackWeight) <= SEED_TIE_EPSILON &&
        (radius > fallbackRadius + SEED_TIE_EPSILON ||
          (Math.abs(radius - fallbackRadius) <= SEED_TIE_EPSILON &&
            idx > fallback)))
    ) {
      fallback = idx;
      fallbackWeight = w;
      fallbackRadius = radius;
    }
  }

  if (count === 1) return fallback;

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
    const w = weights[idx];
    let cost;
    if (
      cachedRow >= 0 &&
      sameGaussian(idx, cachedRow, pos, rgb, covarianceTerms)
    ) {
      cost = cachedCost;
    } else {
      cost = 0;
      const score = logSimilarityFor(
        cloud,
        covarianceTerms,
        idx,
        Number.POSITIVE_INFINITY,
      );
      let q = start;
      for (; q < end; q++) {
        if ((comparisons++ & 4095) === 0) check();
        const other = groupIndices[q];
        cost += weights[other] * -score(other, Number.NEGATIVE_INFINITY);
        if (cost * invTotalWeight > (bestCost + SEED_TIE_EPSILON) * w) break;
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
      weightedCost < bestCost - SEED_TIE_EPSILON ||
      (Math.abs(weightedCost - bestCost) <= SEED_TIE_EPSILON &&
        (medoidCost < bestMedoidCost - SEED_TIE_EPSILON ||
          (Math.abs(medoidCost - bestMedoidCost) <= SEED_TIE_EPSILON &&
            (w > bestWeight + SEED_TIE_EPSILON ||
              (Math.abs(w - bestWeight) <= SEED_TIE_EPSILON &&
                (radius > bestRadius + SEED_TIE_EPSILON ||
                  (Math.abs(radius - bestRadius) <= SEED_TIE_EPSILON &&
                    idx > rep)))))))
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
