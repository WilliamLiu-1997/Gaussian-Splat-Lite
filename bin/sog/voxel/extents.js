const THREE_SIGMA_AABB_ASPECT_PENALTY_EXPONENT = 0.5;
const ELLIPSOID_AREA_P = 1.6075;
const MIN_SPLAT_EXTENT = 1e-12;

function positiveFiniteExtent(value) {
  return Math.max(Number.isFinite(value) ? value : 0.0, MIN_SPLAT_EXTENT);
}

function nonNegativeFiniteScale(value) {
  return Math.max(Number.isFinite(value) ? value : 0.0, 0.0);
}

function threeSigmaAabbBlendedRadiusFromExtents(ex, ey, ez) {
  const sx = positiveFiniteExtent(ex);
  const sy = positiveFiniteExtent(ey);
  const sz = positiveFiniteExtent(ez);
  const volumeEquivalentRadius = Math.cbrt(sx * sy * sz);
  const rmsRadius = Math.sqrt((sx * sx + sy * sy + sz * sz) / 3.0);
  const aspectPenalty = rmsRadius / volumeEquivalentRadius;
  return (
    volumeEquivalentRadius *
    aspectPenalty ** THREE_SIGMA_AABB_ASPECT_PENALTY_EXPONENT
  );
}

function ellipsoidAreaFromScales(sx, sy, sz) {
  const x = nonNegativeFiniteScale(sx);
  const y = nonNegativeFiniteScale(sy);
  const z = nonNegativeFiniteScale(sz);
  const p = ELLIPSOID_AREA_P;
  const numerator = (x * y) ** p + (x * z) ** p + (y * z) ** p;
  return 4.0 * Math.PI * (numerator / 3.0) ** (1.0 / p);
}

function representativeSplatWeightFromScales(opacity, sx, sy, sz) {
  const maxScale = Math.max(
    nonNegativeFiniteScale(sx),
    nonNegativeFiniteScale(sy),
    nonNegativeFiniteScale(sz),
  );
  const alpha = Number.isFinite(opacity) ? opacity : 0.0;
  return maxScale * alpha;
}

export {
  ellipsoidAreaFromScales,
  representativeSplatWeightFromScales,
  threeSigmaAabbBlendedRadiusFromExtents,
};
