import {
  RELATIVE_VARIANCE_FLOOR,
  SCORE_SLACK,
  VARIANCE_BOUND_FACTOR,
} from "../lod-config.js";
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
    const varianceFloor = RELATIVE_VARIANCE_FLOOR * (c00 + c11 + c22);

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
    const largest =
      VARIANCE_BOUND_FACTOR * largestEigenvalue(c00, c01, c02, c11, c12, c22);
    maxVariance[i] = largest < trace ? largest : trace;
  }

  return { components: covariance, logDetQuarter, maxVariance };
}

// SCORE_SLACK allows for scores above the distance bounds through rounding:
// the quarter log determinants are single floats, the determinants round
// with the splats' flatness, and a score above zero is cut to zero. A bound
// rules a pair out only below the score to beat by more than this, so pairs
// that may tie are scored, and the result does not depend on the order of
// scoring. Estimated at 0.001 for the flattest splats that the variance
// floor allows.
function logSimilarityFor(cloud, covarianceTerms, candidate, radius) {
  const { positions: pos, rgb } = cloud;
  const cand3 = candidate * 3;
  const cand6 = candidate * 6;
  const radiusSquared = radius * radius;
  const covComponents = covarianceTerms.components;
  const logDetQuarter = covarianceTerms.logDetQuarter;
  const maxVariance = covarianceTerms.maxVariance;
  const candX = pos[cand3];
  const candY = pos[cand3 + 1];
  const candZ = pos[cand3 + 2];
  const candR = rgb[cand3];
  const candG = rgb[cand3 + 1];
  const candB = rgb[cand3 + 2];
  const candVariance = maxVariance[candidate];
  const candLogDet = logDetQuarter[candidate];
  const a00 = covComponents[cand6];
  const a01 = covComponents[cand6 + 1];
  const a02 = covComponents[cand6 + 2];
  const a11 = covComponents[cand6 + 3];
  const a12 = covComponents[cand6 + 4];
  const a22 = covComponents[cand6 + 5];

  return (other, threshold) => {
    if (candidate === other) return 0;
    const other3 = other * 3;
    const dx = candX - pos[other3];
    const dy = candY - pos[other3 + 1];
    const dz = candZ - pos[other3 + 2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > radiusSquared) return Number.NEGATIVE_INFINITY;
    const dr = candR - rgb[other3];
    const dg = candG - rgb[other3 + 1];
    const db = candB - rgb[other3 + 2];
    const colorLog = -(dr * dr + dg * dg + db * db);
    if (colorLog < threshold) return Number.NEGATIVE_INFINITY;
    const varianceSum = candVariance + maxVariance[other];
    if (
      varianceSum > 0 &&
      colorLog - (0.25 * distanceSquared) / varianceSum + SCORE_SLACK <
        threshold
    )
      return Number.NEGATIVE_INFINITY;

    const other6 = other * 6;
    if (
      distanceSquared === 0 &&
      colorLog === 0 &&
      a00 === covComponents[other6] &&
      a01 === covComponents[other6 + 1] &&
      a02 === covComponents[other6 + 2] &&
      a11 === covComponents[other6 + 3] &&
      a12 === covComponents[other6 + 4] &&
      a22 === covComponents[other6 + 5]
    )
      return 0;
    const m00 = 0.5 * (a00 + covComponents[other6 + 0]);
    const m01 = 0.5 * (a01 + covComponents[other6 + 1]);
    const m02 = 0.5 * (a02 + covComponents[other6 + 2]);
    const m11 = 0.5 * (a11 + covComponents[other6 + 3]);
    const m12 = 0.5 * (a12 + covComponents[other6 + 4]);
    const m22 = 0.5 * (a22 + covComponents[other6 + 5]);
    const cof00 = m11 * m22 - m12 * m12;
    const cof01 = m12 * m02 - m01 * m22;
    const cof02 = m01 * m12 - m11 * m02;
    const detM = m00 * cof00 + m01 * cof01 + m02 * cof02;
    if (!(detM > 0)) return Number.NEGATIVE_INFINITY;
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
    if (colorLog - 0.125 * safeQuad + SCORE_SLACK < threshold)
      return Number.NEGATIVE_INFINITY;
    const logCoefficient =
      candLogDet +
      logDetQuarter[other] -
      0.5 * Math.log(detM) -
      0.125 * safeQuad;
    return Number.isFinite(logCoefficient)
      ? Math.min(0, logCoefficient) + colorLog
      : Number.NEGATIVE_INFINITY;
  };
}

export { prepareBhattacharyyaTerms, logSimilarityFor };
