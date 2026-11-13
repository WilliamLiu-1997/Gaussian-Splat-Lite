import { assignRowsToNeighborGroupsRgbCov } from "./assignment.js";
import { GroupCandidateHeap } from "./candidate-heap.js";
import { fillExactTarget } from "./exact-target.js";
import {
  buildAdaptiveVoxelIndex,
  buildInitialAdaptiveVoxelNeighborSets,
  buildInitialAdaptiveVoxels,
  chooseInitialAdaptiveVoxelGrid,
  computeNormalizedPositions,
  refineAdaptiveVoxels,
} from "./grid.js";
import {
  SCORE_SLACK,
  candidateDistanceFromLog,
  candidateNoveltyFactor,
  candidatePriorityIsBetter,
  gaussianLogSimilarity,
  prepareBhattacharyyaTerms,
} from "./metrics.js";
import {
  buildRepGroupBounds,
  computeAdaptiveMaxRepsByGroup,
  representativeIndexForGroupRange,
} from "./representatives.js";

const REPRESENTATIVES_PER_VOXEL = 24;
const ADAPTIVE_VOXEL_SPLIT_FACTOR = 8;

function planSimplifyCloudVoxel(cloud, target, bounds, check) {
  check();
  const n = cloud.length;
  const voxelTarget = Math.max(
    1,
    Math.floor(target / REPRESENTATIVES_PER_VOXEL),
  );
  const { positions: pos, rgb, covariance } = cloud;
  const ext = bounds.extents().map((v) => Math.max(v, 1e-6));
  const mins = bounds.minimum;
  const invExtents = [1.0 / ext[0], 1.0 / ext[1], 1.0 / ext[2]];
  const normalizedPositions = computeNormalizedPositions(
    pos,
    n,
    mins,
    invExtents,
  );
  const {
    dims,
    cellCounts: initialCellCounts,
    pointFlats: initialPointFlats,
  } = chooseInitialAdaptiveVoxelGrid(
    bounds,
    voxelTarget,
    normalizedPositions,
    n,
  );
  const expectedRowsPerVoxel = n / Math.max(1, voxelTarget);
  const splitThreshold = Math.max(
    2,
    Math.ceil(expectedRowsPerVoxel * ADAPTIVE_VOXEL_SPLIT_FACTOR),
  );
  const {
    groups: initialGroups,
    groupKeys: initialGroupKeys,
    groupForFlat: initialGroupForFlat,
  } = buildInitialAdaptiveVoxels(n, dims, initialCellCounts, initialPointFlats);
  const initialNeighborSets = buildInitialAdaptiveVoxelNeighborSets(
    initialGroups,
    initialGroupKeys,
    initialGroupForFlat,
    dims,
  );
  const { groups: adaptiveGroups, neighborGroupsByGroup } =
    refineAdaptiveVoxels(
      initialGroups,
      initialNeighborSets,
      normalizedPositions,
      splitThreshold,
      target,
    );
  const groupCount = adaptiveGroups.length;
  const { groupOffsets, groupIndices } = buildAdaptiveVoxelIndex(
    adaptiveGroups,
    n,
  );

  const origRadius = cloud.radius;
  const coarseWeights = cloud.weight;
  for (let i = 0; i < n; i++)
    coarseWeights[i] = Math.max(coarseWeights[i], 1e-12);
  const covarianceTerms = prepareBhattacharyyaTerms(covariance, n);
  const selected = [];
  const assignment = new Int32Array(n).fill(-1);
  const groupReps = new Array(groupCount);
  for (let group = 0; group < groupCount; group++) {
    if ((group & 255) === 0) check();
    const start = groupOffsets[group];
    const end = groupOffsets[group + 1];
    const coarseRep = representativeIndexForGroupRange(
      cloud,
      groupIndices,
      start,
      end,
      coarseWeights,
      origRadius,
      covarianceTerms,
      rgb,
      splitThreshold * 8,
      check,
    );
    const coarseOutIdx = selected.length;
    selected.push(coarseRep);
    assignment[coarseRep] = coarseOutIdx;
    groupReps[group] = [coarseOutIdx];
  }

  const maxRepsByGroup = computeAdaptiveMaxRepsByGroup(
    groupIndices,
    groupOffsets,
    target,
    REPRESENTATIVES_PER_VOXEL,
    cloud.opacity,
  );

  const createCandidateState = () => {
    const candidateStarts = new Uint32Array(groupCount + 1);
    for (let group = 0; group < groupCount; group++)
      candidateStarts[group + 1] =
        candidateStarts[group] +
        groupOffsets[group + 1] -
        groupOffsets[group] -
        groupReps[group].length;
    const capacity = candidateStarts[groupCount];
    const candidateRows = new Int32Array(capacity);
    const candidateLogSimilarities = new Float32Array(capacity);
    // Each candidate's novelty factor for its cached similarity, an
    // exponential: scans compare every candidate each time one is selected.
    const candidateNovelties = new Float64Array(capacity);
    const candidateLengths = new Uint32Array(groupCount);
    const groupBestIndex = new Int32Array(groupCount).fill(-1);

    for (let group = 0; group < groupCount; group++) {
      const start = groupOffsets[group];
      const end = groupOffsets[group + 1];
      const slotStart = candidateStarts[group];
      const rep = selected[groupReps[group][0]];
      let length = 0;
      let bestRow = -1;
      let bestNovelty = 0.0;
      for (let p = start; p < end; p++) {
        if ((p & 1023) === 0) check();
        const row = groupIndices[p];
        if (assignment[row] >= 0) continue;
        const similarity = Math.fround(
          gaussianLogSimilarity(covarianceTerms, pos, rgb, row, rep),
        );
        if (similarity >= 0.0) continue;
        const slot = slotStart + length;
        candidateRows[slot] = row;
        candidateLogSimilarities[slot] = similarity;
        const novelty = candidateNoveltyFactor(
          candidateDistanceFromLog(similarity),
        );
        candidateNovelties[slot] = novelty;
        if (
          candidatePriorityIsBetter(
            row,
            novelty,
            bestRow,
            bestNovelty,
            coarseWeights,
            origRadius,
          )
        ) {
          groupBestIndex[group] = length;
          bestRow = row;
          bestNovelty = novelty;
        }
        length++;
      }
      candidateLengths[group] = length;
    }

    const findGroupBest = (group, out) => {
      const bestIndex = groupBestIndex[group];
      if (bestIndex < 0) return false;
      const slot = candidateStarts[group] + bestIndex;
      out.row = candidateRows[slot];
      out.distance = candidateDistanceFromLog(candidateLogSimilarities[slot]);
      // candidateNoveltyFactor() of that distance, cached with it.
      out.novelty = candidateNovelties[slot];
      return true;
    };

    const selectCandidate = (group, rep) => {
      let length = --candidateLengths[group];
      const selectedIndex = groupBestIndex[group];
      const slotStart = candidateStarts[group];
      if (selectedIndex !== length) {
        const dst = slotStart + selectedIndex;
        const src = slotStart + length;
        candidateRows[dst] = candidateRows[src];
        candidateLogSimilarities[dst] = candidateLogSimilarities[src];
        candidateNovelties[dst] = candidateNovelties[src];
      }
      if (length === 0) {
        groupBestIndex[group] = -1;
        return;
      }

      const covComponents = covarianceTerms.components;
      const logDetQuarter = covarianceTerms.logDetQuarter;
      const maxVariance = covarianceTerms.maxVariance;
      const rep3 = rep * 3;
      const rep6 = rep * 6;
      const repR = rgb[rep3 + 0];
      const repG = rgb[rep3 + 1];
      const repB = rgb[rep3 + 2];
      const repX = pos[rep3 + 0];
      const repY = pos[rep3 + 1];
      const repZ = pos[rep3 + 2];
      const repVariance = maxVariance[rep];
      const repLogDet = logDetQuarter[rep];
      const b00 = covComponents[rep6 + 0];
      const b01 = covComponents[rep6 + 1];
      const b02 = covComponents[rep6 + 2];
      const b11 = covComponents[rep6 + 3];
      const b12 = covComponents[rep6 + 4];
      const b22 = covComponents[rep6 + 5];

      let bestIndex = -1;
      let bestRow = -1;
      let bestNovelty = 0.0;
      let i = 0;
      let compared = 0;
      while (i < length) {
        if ((compared++ & 4095) === 0) check();
        const slot = slotStart + i;
        let cached = candidateLogSimilarities[slot];
        if (cached < 0.0) {
          const candRow = candidateRows[slot];
          const cand3 = candRow * 3;
          const dr = rgb[cand3 + 0] - repR;
          const dg = rgb[cand3 + 1] - repG;
          const db = rgb[cand3 + 2] - repB;
          const colorLog = -(dr * dr + dg * dg + db * db);
          let logSimilarity = Number.NEGATIVE_INFINITY;
          if (colorLog >= cached) {
            const dx = pos[cand3 + 0] - repX;
            const dy = pos[cand3 + 1] - repY;
            const dz = pos[cand3 + 2] - repZ;
            let proceed = true;
            if (cached > Number.NEGATIVE_INFINITY) {
              const varianceSum = maxVariance[candRow] + repVariance;
              if (varianceSum > 0.0) {
                const upperBound =
                  colorLog -
                  (0.25 * (dx * dx + dy * dy + dz * dz)) / varianceSum;
                if (upperBound + SCORE_SLACK < cached) {
                  proceed = false;
                }
              }
            }
            if (proceed) {
              const candLogDet = logDetQuarter[candRow];
              const cand6 = candRow * 6;
              const a00 = covComponents[cand6 + 0];
              const a01 = covComponents[cand6 + 1];
              const a02 = covComponents[cand6 + 2];
              const a11 = covComponents[cand6 + 3];
              const a12 = covComponents[cand6 + 4];
              const a22 = covComponents[cand6 + 5];
              const m00 = 0.5 * (a00 + b00);
              const m01 = 0.5 * (a01 + b01);
              const m02 = 0.5 * (a02 + b02);
              const m11 = 0.5 * (a11 + b11);
              const m12 = 0.5 * (a12 + b12);
              const m22 = 0.5 * (a22 + b22);
              const cof00 = m11 * m22 - m12 * m12;
              const cof01 = m12 * m02 - m01 * m22;
              const cof02 = m01 * m12 - m11 * m02;
              const detM = m00 * cof00 + m01 * cof01 + m02 * cof02;
              if (detM > 0.0) {
                const invDetM = 1.0 / detM;
                const inv00 = cof00 * invDetM;
                const inv01 = cof01 * invDetM;
                const inv02 = cof02 * invDetM;
                const inv11 = (m00 * m22 - m02 * m02) * invDetM;
                const inv12 = (m01 * m02 - m00 * m12) * invDetM;
                const inv22 = (m00 * m11 - m01 * m01) * invDetM;
                const quad =
                  dx * (inv00 * dx + inv01 * dy + inv02 * dz) +
                  dy * (inv01 * dx + inv11 * dy + inv12 * dz) +
                  dz * (inv02 * dx + inv12 * dy + inv22 * dz);
                const safeQuad = quad > 0.0 ? quad : 0.0;
                // The determinants only lower a score, by their logarithm:
                // the Mahalanobis term alone may already rule the pair out.
                if (colorLog - 0.125 * safeQuad + SCORE_SLACK >= cached) {
                  const logCoefficient =
                    candLogDet +
                    repLogDet -
                    0.5 * Math.log(detM) -
                    0.125 * safeQuad;
                  if (Number.isFinite(logCoefficient)) {
                    const bhatLog = logCoefficient > 0.0 ? 0.0 : logCoefficient;
                    logSimilarity = bhatLog + colorLog;
                  }
                }
              }
            }
          }
          if (logSimilarity > cached) {
            cached = Math.fround(logSimilarity);
            candidateLogSimilarities[slot] = cached;
            candidateNovelties[slot] = candidateNoveltyFactor(
              candidateDistanceFromLog(cached),
            );
          }
        }
        if (cached >= 0.0) {
          length -= 1;
          if (i !== length) {
            const lastSlot = slotStart + length;
            candidateRows[slot] = candidateRows[lastSlot];
            candidateLogSimilarities[slot] = candidateLogSimilarities[lastSlot];
            candidateNovelties[slot] = candidateNovelties[lastSlot];
          }
        } else {
          const row = candidateRows[slot];
          const novelty = candidateNovelties[slot];
          if (
            candidatePriorityIsBetter(
              row,
              novelty,
              bestRow,
              bestNovelty,
              coarseWeights,
              origRadius,
            )
          ) {
            bestIndex = i;
            bestRow = row;
            bestNovelty = novelty;
          }
          i += 1;
        }
      }
      candidateLengths[group] = length;
      groupBestIndex[group] = bestIndex;
    };

    return { findGroupBest, selectCandidate };
  };

  if (selected.length < target) {
    check();
    const state = createCandidateState();
    const best = {};
    for (
      let group = 0;
      group < groupCount && selected.length < target;
      group++
    ) {
      const reps = groupReps[group];
      const maxReps = maxRepsByGroup[group];
      while (reps.length < maxReps && selected.length < target) {
        if ((selected.length & 1023) === 0) check();
        if (!state.findGroupBest(group, best)) {
          break;
        }
        const bestRow = best.row;
        const outIdx = selected.length;
        selected.push(bestRow);
        assignment[bestRow] = outIdx;
        reps.push(outIdx);
        // The candidates are not used once the target is reached.
        if (selected.length === target) break;
        state.selectCandidate(group, bestRow);
      }
    }

    if (selected.length < target) {
      check();
      const heap = new GroupCandidateHeap(groupCount);
      const heapEntry = {};

      const pushGroupBest = (group) => {
        if ((group & 255) === 0) check();
        if (!state.findGroupBest(group, best)) {
          return;
        }
        const weight = coarseWeights[best.row];
        heap.push(
          group,
          best.row,
          best.distance,
          weight,
          best.novelty * Math.max(weight, 1e-12),
          origRadius[best.row],
        );
      };

      for (let group = 0; group < groupCount; group++) {
        pushGroupBest(group);
      }

      while (selected.length < target && heap.length > 0) {
        if ((selected.length & 1023) === 0) check();
        heap.pop(heapEntry);
        const group = heapEntry.group;
        const rep = heapEntry.row;
        if (assignment[rep] >= 0) {
          continue;
        }

        const outIdx = selected.length;
        selected.push(rep);
        assignment[rep] = outIdx;
        groupReps[group].push(outIdx);
        if (selected.length === target) break;
        state.selectCandidate(group, rep);
        pushGroupBest(group);
      }
    }
  }

  const repGroupBounds = buildRepGroupBounds(
    groupReps,
    selected,
    pos,
    rgb,
    covarianceTerms,
  );
  assignRowsToNeighborGroupsRgbCov(
    neighborGroupsByGroup,
    groupReps,
    repGroupBounds,
    groupCount,
    groupOffsets,
    groupIndices,
    assignment,
    pos,
    rgb,
    covarianceTerms,
    check,
  );
  fillExactTarget(cloud, selected, assignment, target, covarianceTerms, check);

  return {
    selected,
    assignment,
  };
}

export { planSimplifyCloudVoxel };
