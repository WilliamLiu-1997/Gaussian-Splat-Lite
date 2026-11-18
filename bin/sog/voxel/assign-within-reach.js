import { SEARCH_RADIUS_FEATURES } from "../lod-config.js";
import { logSimilarityFor } from "./metrics.js";

export function findWithinReach(
  cloud,
  row,
  terms,
  selected,
  groupSlots,
  groupsFor,
  check,
) {
  const { positions, featureSize } = cloud;
  const radius = SEARCH_RADIUS_FEATURES * featureSize[row];
  const radiusSquared = radius * radius;
  const scoreFor = logSimilarityFor(cloud, terms, row, radius);
  const x = positions[3 * row];
  const y = positions[3 * row + 1];
  const z = positions[3 * row + 2];
  let bestSlot = -1;
  let best = Number.NEGATIVE_INFINITY;
  let visits = 0;
  for (const group of groupsFor(row, radius)) {
    for (const slot of groupSlots[group]) {
      if ((++visits & 4095) === 0) check();
      const rep = selected[slot];
      const dx = x - positions[3 * rep];
      const dy = y - positions[3 * rep + 1];
      const dz = z - positions[3 * rep + 2];
      if (dx * dx + dy * dy + dz * dz > radiusSquared) continue;
      const score = scoreFor(rep, best);
      if (bestSlot < 0 || score > best || (score === best && slot < bestSlot)) {
        best = score;
        bestSlot = slot;
      }
    }
  }
  return bestSlot;
}
