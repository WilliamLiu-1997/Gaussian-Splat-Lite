function determinantSymmetric3(c00, c01, c02, c11, c12, c22) {
  return (
    c00 * (c11 * c22 - c12 * c12) -
    c01 * (c01 * c22 - c12 * c02) +
    c02 * (c01 * c12 - c11 * c02)
  );
}

// The largest eigenvalue of a symmetric 3×3 matrix.
function largestEigenvalue(c00, c01, c02, c11, c12, c22) {
  const mean = (c00 + c11 + c22) / 3.0;
  const d00 = c00 - mean;
  const d11 = c11 - mean;
  const d22 = c22 - mean;
  const p = Math.sqrt(
    (d00 * d00 +
      d11 * d11 +
      d22 * d22 +
      2.0 * (c01 * c01 + c02 * c02 + c12 * c12)) /
      6.0,
  );
  if (!(p > 0.0)) {
    return mean;
  }
  const r =
    determinantSymmetric3(d00, c01, c02, d11, c12, d22) / (2.0 * p * p * p);
  const phi = Math.acos(Math.max(-1.0, Math.min(1.0, r))) / 3.0;
  return mean + 2.0 * p * Math.cos(phi);
}

function prepareBhattacharyyaTerms(covariance, rowCount) {
  const logDetQuarter = new Float32Array(rowCount);
  const maxVariance = new Float32Array(rowCount);

  for (let i = 0; i < rowCount; i++) {
    const base = i * 6;
    let c00 = covariance[base + 0];
    const c01 = covariance[base + 1];
    const c02 = covariance[base + 2];
    let c11 = covariance[base + 3];
    const c12 = covariance[base + 4];
    let c22 = covariance[base + 5];
    let determinant = determinantSymmetric3(c00, c01, c02, c11, c12, c22);
    const minorSum =
      c00 * c11 - c01 * c01 + c00 * c22 - c02 * c02 + c11 * c22 - c12 * c12;
    const varianceFloor = 1e-6 * (c00 + c11 + c22);

    // det / minorSum bounds the smallest positive eigenvalue from below.
    // Regularize only the scoring cache; merging rebuilds the original shape.
    if (!(minorSum > 0 && determinant > varianceFloor * minorSum)) {
      const correction =
        determinant > 0 && minorSum > 0
          ? varianceFloor - determinant / minorSum
          : varianceFloor;
      covariance[base + 0] = c00 + correction;
      covariance[base + 3] = c11 + correction;
      covariance[base + 5] = c22 + correction;
      c00 = covariance[base + 0];
      c11 = covariance[base + 3];
      c22 = covariance[base + 5];
      determinant = determinantSymmetric3(c00, c01, c02, c11, c12, c22);
    }

    if (!(determinant > 0 && Number.isFinite(determinant)))
      throw new Error(`Invalid scoring covariance for splat ${i}`);
    logDetQuarter[i] = 0.25 * Math.log(determinant);
    // An upper bound of the variance along any direction, for the distance
    // bounds: half the sum of two splats' bounds the largest eigenvalue of
    // their mean covariance. The margin covers rounding; the trace is a
    // bound of its own.
    const trace = c00 + c11 + c22;
    const largest = 1.001 * largestEigenvalue(c00, c01, c02, c11, c12, c22);
    maxVariance[i] = largest < trace ? largest : trace;
  }

  return { components: covariance, logDetQuarter, maxVariance };
}

function colorLogSimilarityRgb(rgb, lhs, rhs) {
  const a = lhs * 3;
  const b = rhs * 3;
  const dr = rgb[a + 0] - rgb[b + 0];
  const dg = rgb[a + 1] - rgb[b + 1];
  const db = rgb[a + 2] - rgb[b + 2];
  return -(dr * dr + dg * dg + db * db);
}

function bhattacharyyaLogCoeffPrepared(covarianceTerms, pos, lhs, rhs) {
  const covariance = covarianceTerms.components;
  const a = lhs * 6;
  const b = rhs * 6;
  const a00 = covariance[a + 0];
  const a01 = covariance[a + 1];
  const a02 = covariance[a + 2];
  const a11 = covariance[a + 3];
  const a12 = covariance[a + 4];
  const a22 = covariance[a + 5];
  const b00 = covariance[b + 0];
  const b01 = covariance[b + 1];
  const b02 = covariance[b + 2];
  const b11 = covariance[b + 3];
  const b12 = covariance[b + 4];
  const b22 = covariance[b + 5];

  const m00 = 0.5 * (a00 + b00);
  const m01 = 0.5 * (a01 + b01);
  const m02 = 0.5 * (a02 + b02);
  const m11 = 0.5 * (a11 + b11);
  const m12 = 0.5 * (a12 + b12);
  const m22 = 0.5 * (a22 + b22);
  const logDetA = covarianceTerms.logDetQuarter[lhs];
  const logDetB = covarianceTerms.logDetQuarter[rhs];
  const detM = determinantSymmetric3(m00, m01, m02, m11, m12, m22);
  if (detM <= 0.0) {
    return Number.NEGATIVE_INFINITY;
  }

  const invDetM = 1.0 / detM;
  const inv00 = (m11 * m22 - m12 * m12) * invDetM;
  const inv01 = (m02 * m12 - m01 * m22) * invDetM;
  const inv02 = (m01 * m12 - m02 * m11) * invDetM;
  const inv11 = (m00 * m22 - m02 * m02) * invDetM;
  const inv12 = (m01 * m02 - m00 * m12) * invDetM;
  const inv22 = (m00 * m11 - m01 * m01) * invDetM;
  const lhs3 = lhs * 3;
  const rhs3 = rhs * 3;
  const dx = pos[lhs3 + 0] - pos[rhs3 + 0];
  const dy = pos[lhs3 + 1] - pos[rhs3 + 1];
  const dz = pos[lhs3 + 2] - pos[rhs3 + 2];
  const quad =
    dx * (inv00 * dx + inv01 * dy + inv02 * dz) +
    dy * (inv01 * dx + inv11 * dy + inv12 * dz) +
    dz * (inv02 * dx + inv12 * dy + inv22 * dz);
  const logCoefficient =
    logDetA + logDetB - 0.5 * Math.log(detM) - 0.125 * Math.max(quad, 0.0);
  return Number.isFinite(logCoefficient)
    ? Math.min(0.0, logCoefficient)
    : Number.NEGATIVE_INFINITY;
}

function gaussianLogSimilarity(covarianceTerms, pos, rgb, lhs, rhs) {
  return (
    bhattacharyyaLogCoeffPrepared(covarianceTerms, pos, lhs, rhs) +
    colorLogSimilarityRgb(rgb, lhs, rhs)
  );
}

// How far a score may lie above the distance bounds through its rounding:
// the quarter log determinants are single floats, the determinants round
// with the splats' flatness, and a score above zero is cut to zero. A bound
// rules a pair out only below the score to beat by more than this, so pairs
// that may tie are scored, and the result does not depend on the order of
// scoring. Estimated at 0.001 for the flattest splats that the variance
// floor allows.
const SCORE_SLACK = 0.01;

const CANDIDATE_NOVELTY_DISTANCE_SCALE = 3.0;

// Of a distance from candidateDistanceFromLog(): 0 or more, or infinite.
function candidateNoveltyFactor(distance) {
  return 1.0 - Math.exp(-distance / CANDIDATE_NOVELTY_DISTANCE_SCALE);
}

// Of a log similarity, which is at most 0 or minus infinity, never NaN.
function candidateDistanceFromLog(logSimilarity) {
  return Math.max(0.0, -logSimilarity);
}

// `novelty` and `bestNovelty` are the candidates' candidateNoveltyFactor().
function candidatePriorityIsBetter(
  row,
  novelty,
  bestRow,
  bestNovelty,
  weights,
  radii,
) {
  if (bestRow < 0) {
    return true;
  }
  const weight = weights[row];
  const bestWeight = weights[bestRow];
  const priority = novelty * Math.max(weight, 1e-12);
  const bestPriority = bestNovelty * Math.max(bestWeight, 1e-12);
  if (priority > bestPriority + 1e-12) {
    return true;
  }
  if (Math.abs(priority - bestPriority) > 1e-12) {
    return false;
  }

  if (novelty > bestNovelty + 1e-12) {
    return true;
  }
  if (Math.abs(novelty - bestNovelty) > 1e-12) {
    return false;
  }

  const weightDiff = weight - bestWeight;
  if (Math.abs(weightDiff) > 1e-12) {
    return weightDiff > 0.0;
  }

  const radiusDiff = radii[row] - radii[bestRow];
  if (Math.abs(radiusDiff) > 1e-12) {
    return radiusDiff > 0.0;
  }
  return row > bestRow;
}

export {
  SCORE_SLACK,
  candidateDistanceFromLog,
  candidateNoveltyFactor,
  candidatePriorityIsBetter,
  gaussianLogSimilarity,
  prepareBhattacharyyaTerms,
};
