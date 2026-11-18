import { SEARCH_RADIUS_FEATURES } from "../lod-config.js";
import { findWithinReach } from "./assign-within-reach.js";
import { logSimilarityFor } from "./metrics.js";

// The first integer radius multiple containing the point. Check the squared
// boundary to agree with the coverage search when the division rounds.
function coverageTier(distanceSquared, size) {
  if (distanceSquared <= (SEARCH_RADIUS_FEATURES * size) ** 2)
    return SEARCH_RADIUS_FEATURES;
  let tier = Math.ceil(Math.sqrt(distanceSquared) / size);
  if (distanceSquared <= ((tier - 1) * size) ** 2) tier--;
  if (distanceSquared > (tier * size) ** 2) tier++;
  return tier;
}

export function assignRemainingRows(
  cloud,
  { selected, assignment, groupSlots },
  terms,
  groupsFor,
  nodes,
  groupOffsets,
  groupIndices,
  check,
  report,
) {
  const { positions, featureSize } = cloud;

  function assignOutsideReach(row, seedRep) {
    const size = featureSize[row];
    const x = positions[row * 3];
    const y = positions[row * 3 + 1];
    const z = positions[row * 3 + 2];
    const logSimilarity = logSimilarityFor(
      cloud,
      terms,
      row,
      Number.POSITIVE_INFINITY,
    );
    // A known representative bounds the first nonempty tier.
    const seedX = x - positions[3 * seedRep];
    const seedY = y - positions[3 * seedRep + 1];
    const seedZ = z - positions[3 * seedRep + 2];
    let bestTier = coverageTier(
      seedX * seedX + seedY * seedY + seedZ * seedZ,
      size,
    );
    let bestLog = Number.NEGATIVE_INFINITY;
    let bestSlot = -1;
    let visits = 0;
    for (let i = 0; i < nodes.length; ) {
      const node = nodes[i++];
      const gapX = Math.max(0, node.min[0] - x, x - node.max[0]);
      const gapY = Math.max(0, node.min[1] - y, y - node.max[1]);
      const gapZ = Math.max(0, node.min[2] - z, z - node.max[2]);
      if (gapX * gapX + gapY * gapY + gapZ * gapZ > (bestTier * size) ** 2) {
        if (node.group < 0) i = node.end;
        continue;
      }
      if (node.group < 0) continue;
      for (const slot of groupSlots[node.group]) {
        if ((++visits & 4095) === 0) check();
        const rep = selected[slot];
        const at = rep * 3;
        const dx = positions[at] - x;
        const dy = positions[at + 1] - y;
        const dz = positions[at + 2] - z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > (bestTier * size) ** 2) continue;
        const tier = coverageTier(distanceSquared, size);
        const score = logSimilarity(
          rep,
          tier < bestTier ? Number.NEGATIVE_INFINITY : bestLog,
        );
        if (
          tier < bestTier ||
          bestSlot < 0 ||
          score > bestLog ||
          (score === bestLog && slot < bestSlot)
        ) {
          bestTier = tier;
          bestLog = score;
          bestSlot = slot;
        }
      }
    }
    assignment[row] = bestSlot;
  }

  for (let group = 0; group < groupSlots.length; group++) {
    const seedRep = selected[groupSlots[group][0]];
    for (let p = groupOffsets[group]; p < groupOffsets[group + 1]; p++) {
      if ((p & 1023) === 0) {
        check();
        report?.(p);
      }
      const row = groupIndices[p];
      if (assignment[row] >= 0) continue;
      const slot = findWithinReach(
        cloud,
        row,
        terms,
        selected,
        groupSlots,
        groupsFor,
        check,
      );
      if (slot >= 0) assignment[row] = slot;
      else assignOutsideReach(row, seedRep);
    }
  }
}
