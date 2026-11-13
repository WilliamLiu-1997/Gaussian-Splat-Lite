import { SCORE_SLACK } from "./metrics.js";

// Final assignment when RGB and covariance terms are both present: every
// splat that is not a representative goes to the most similar representative
// of its voxel and the voxels around it. buildRepGroupBounds() lays each
// voxel's representatives side by side, the largest first: what the distance
// bound reads of each, its center and largest variance, apart from what only
// a full score reads.
const REP_REACH_STRIDE = 4;
const REP_REACH_VARIANCE = 3;
const REP_TERMS_STRIDE = 10;
const REP_TERMS_RGB = 0;
const REP_TERMS_COV = 3;
const REP_TERMS_LOG_DET = 9;

function assignRowsToNeighborGroupsRgbCov(
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
) {
  const covComponents = covarianceTerms.components;
  const logDetQuarter = covarianceTerms.logDetQuarter;
  const maxVariance = covarianceTerms.maxVariance;
  const posMin = repGroupBounds.posMin;
  const posMax = repGroupBounds.posMax;
  const rgbMin = repGroupBounds.rgbMin;
  const rgbMax = repGroupBounds.rgbMax;
  const repStarts = repGroupBounds.repStarts;
  const repSlots = repGroupBounds.repSlots;
  const repRanks = repGroupBounds.repRanks;
  const repReach = repGroupBounds.repReach;
  const repTerms = repGroupBounds.repTerms;
  let comparisons = 0;

  // Every group is nonempty and its neighbors include the group itself.
  for (let group = 0; group < groupCount; group++) {
    if ((group & 255) === 0) check();
    const start = groupOffsets[group];
    const end = groupOffsets[group + 1];
    const neighborGroups = neighborGroupsByGroup[group];
    let repCount = 0;
    let ownGroupRank = -1;
    for (let i = 0; i < neighborGroups.length; i++) {
      const repGroup = neighborGroups[i];
      const reps = groupReps[repGroup];
      if (repGroup === group) {
        ownGroupRank = repCount;
      }
      repCount += reps.length;
    }
    if (repCount === 1) {
      const onlySlot = groupReps[group][0];
      for (let p = start; p < end; p++) {
        if ((p & 4095) === 0) check();
        assignment[groupIndices[p]] = onlySlot;
      }
      continue;
    }

    for (let p = start; p < end; p++) {
      if ((p & 1023) === 0) check();
      const orig = groupIndices[p];
      if (assignment[orig] >= 0) {
        continue;
      }
      const orig3 = orig * 3;
      const orig6 = orig * 6;
      const origR = rgb[orig3 + 0];
      const origG = rgb[orig3 + 1];
      const origB = rgb[orig3 + 2];
      const origX = pos[orig3 + 0];
      const origY = pos[orig3 + 1];
      const origZ = pos[orig3 + 2];
      const origVariance = maxVariance[orig];
      const origLogDet = logDetQuarter[orig];
      const a00 = covComponents[orig6 + 0];
      const a01 = covComponents[orig6 + 1];
      const a02 = covComponents[orig6 + 2];
      const a11 = covComponents[orig6 + 3];
      const a12 = covComponents[orig6 + 4];
      const a22 = covComponents[orig6 + 5];

      let bestSlot = -1;
      let bestLogSimilarity = Number.NEGATIVE_INFINITY;
      let bestOriginalRank = Number.POSITIVE_INFINITY;

      // Evaluate the row's own voxel first to establish a useful bound, then
      // visit the remaining voxels in their sorted order. A representative's
      // rank is its place in that order and among its voxel's
      // representatives as selected, so equal similarities have the same
      // deterministic winner in any evaluation order.
      let originalRankCursor = 0;
      for (let visit = -1; visit < neighborGroups.length; visit++) {
        let repGroup;
        let originalRankStart;
        if (visit < 0) {
          repGroup = group;
          originalRankStart = ownGroupRank;
        } else {
          repGroup = neighborGroups[visit];
          originalRankStart = originalRankCursor;
          originalRankCursor += groupReps[repGroup].length;
          if (repGroup === group) {
            continue;
          }
        }

        const first = repStarts[repGroup];
        const last = repStarts[repGroup + 1];
        // A quarter of the squared distance to the box of the voxel's
        // representatives: no representative is nearer.
        let quarterGap = 0.0;
        if (bestLogSimilarity > Number.NEGATIVE_INFINITY) {
          const bound3 = repGroup * 3;
          let dr = 0.0;
          if (origR < rgbMin[bound3 + 0]) {
            dr = rgbMin[bound3 + 0] - origR;
          } else if (origR > rgbMax[bound3 + 0]) {
            dr = origR - rgbMax[bound3 + 0];
          }
          let dg = 0.0;
          if (origG < rgbMin[bound3 + 1]) {
            dg = rgbMin[bound3 + 1] - origG;
          } else if (origG > rgbMax[bound3 + 1]) {
            dg = origG - rgbMax[bound3 + 1];
          }
          let db = 0.0;
          if (origB < rgbMin[bound3 + 2]) {
            db = rgbMin[bound3 + 2] - origB;
          } else if (origB > rgbMax[bound3 + 2]) {
            db = origB - rgbMax[bound3 + 2];
          }
          const colorUpperBound = -(dr * dr + dg * dg + db * db);
          if (
            colorUpperBound < bestLogSimilarity ||
            (colorUpperBound === bestLogSimilarity &&
              originalRankStart >= bestOriginalRank)
          ) {
            continue;
          }

          let dx = 0.0;
          if (origX < posMin[bound3 + 0]) {
            dx = posMin[bound3 + 0] - origX;
          } else if (origX > posMax[bound3 + 0]) {
            dx = origX - posMax[bound3 + 0];
          }
          let dy = 0.0;
          if (origY < posMin[bound3 + 1]) {
            dy = posMin[bound3 + 1] - origY;
          } else if (origY > posMax[bound3 + 1]) {
            dy = origY - posMax[bound3 + 1];
          }
          let dz = 0.0;
          if (origZ < posMin[bound3 + 2]) {
            dz = posMin[bound3 + 2] - origZ;
          } else if (origZ > posMax[bound3 + 2]) {
            dz = origZ - posMax[bound3 + 2];
          }
          quarterGap = 0.25 * (dx * dx + dy * dy + dz * dz);
          // The voxel's first representative has its largest variance.
          const varianceSum =
            origVariance +
            repReach[first * REP_REACH_STRIDE + REP_REACH_VARIANCE];
          if (varianceSum > 0.0) {
            const upperBound = colorUpperBound - quarterGap / varianceSum;
            if (upperBound + SCORE_SLACK < bestLogSimilarity) {
              continue;
            }
          }
        }

        for (let rep = first; rep < last; rep++) {
          if ((comparisons++ & 4095) === 0) check();
          const reach = rep * REP_REACH_STRIDE;
          // Colors only lower a similarity, so a distance that the variances
          // do not span rules a representative out before anything else is
          // read. Across the gap to the box, it also rules out the smaller
          // representatives after it. Within the slack of the best, a
          // representative is scored: it may tie.
          const span =
            (SCORE_SLACK - bestLogSimilarity) *
            (origVariance + repReach[reach + REP_REACH_VARIANCE]);
          if (quarterGap > span) {
            break;
          }
          const dx = origX - repReach[reach + 0];
          const dy = origY - repReach[reach + 1];
          const dz = origZ - repReach[reach + 2];
          const quarterDistance = 0.25 * (dx * dx + dy * dy + dz * dz);
          if (quarterDistance > span) {
            continue;
          }

          const originalRank = originalRankStart + repRanks[rep];
          const terms = rep * REP_TERMS_STRIDE;
          const dr = origR - repTerms[terms + REP_TERMS_RGB + 0];
          const dg = origG - repTerms[terms + REP_TERMS_RGB + 1];
          const db = origB - repTerms[terms + REP_TERMS_RGB + 2];
          const colorLog = -(dr * dr + dg * dg + db * db);
          if (
            colorLog < bestLogSimilarity ||
            (colorLog === bestLogSimilarity && originalRank >= bestOriginalRank)
          ) {
            continue;
          }

          const varianceSum =
            origVariance + repReach[reach + REP_REACH_VARIANCE];
          if (varianceSum > 0.0) {
            const upperBound = colorLog - quarterDistance / varianceSum;
            if (upperBound + SCORE_SLACK < bestLogSimilarity) {
              continue;
            }
          }

          const logDetB = repTerms[terms + REP_TERMS_LOG_DET];
          const b00 = repTerms[terms + REP_TERMS_COV + 0];
          const b01 = repTerms[terms + REP_TERMS_COV + 1];
          const b02 = repTerms[terms + REP_TERMS_COV + 2];
          const b11 = repTerms[terms + REP_TERMS_COV + 3];
          const b12 = repTerms[terms + REP_TERMS_COV + 4];
          const b22 = repTerms[terms + REP_TERMS_COV + 5];
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
          if (detM <= 0.0) {
            continue;
          }
          const invDetM = 1.0 / detM;
          const inv00 = cof00 * invDetM;
          const inv01 = cof01 * invDetM;
          const inv02 = cof02 * invDetM;
          const inv11 = (m00 * m22 - m02 * m02) * invDetM;
          const inv12 = (m01 * m02 - m00 * m12) * invDetM;
          const inv22 = (m00 * m11 - m01 * m01) * invDetM;
          const quad =
            inv00 * dx * dx +
            inv11 * dy * dy +
            inv22 * dz * dz +
            2.0 * (inv01 * dx * dy + inv02 * dx * dz + inv12 * dy * dz);
          const safeQuad = quad > 0.0 ? quad : 0.0;
          // The determinants only lower a score, by their logarithm: the
          // Mahalanobis term alone may already rule the pair out.
          if (colorLog - 0.125 * safeQuad + SCORE_SLACK < bestLogSimilarity) {
            continue;
          }
          const logCoefficient =
            origLogDet + logDetB - 0.5 * Math.log(detM) - 0.125 * safeQuad;
          if (!Number.isFinite(logCoefficient)) {
            continue;
          }
          const bhatLog = logCoefficient > 0.0 ? 0.0 : logCoefficient;
          const logSimilarity = bhatLog + colorLog;

          if (
            logSimilarity > bestLogSimilarity ||
            (bestLogSimilarity > Number.NEGATIVE_INFINITY &&
              logSimilarity === bestLogSimilarity &&
              originalRank < bestOriginalRank)
          ) {
            bestLogSimilarity = logSimilarity;
            bestSlot = repSlots[rep];
            bestOriginalRank = originalRank;
          }
        }
        if (bestLogSimilarity >= 0.0 && bestOriginalRank === 0) {
          break;
        }
      }
      if (bestSlot < 0)
        throw new Error(`No valid representative score for splat ${orig}`);
      assignment[orig] = bestSlot;
    }
  }
}

export {
  REP_REACH_STRIDE,
  REP_REACH_VARIANCE,
  REP_TERMS_STRIDE,
  REP_TERMS_RGB,
  REP_TERMS_COV,
  REP_TERMS_LOG_DET,
  assignRowsToNeighborGroupsRgbCov,
};
