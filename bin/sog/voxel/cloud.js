import { opacityRadius } from "../../rad/math.js";
import { SH_C0 } from "../splats.js";
import { covarianceComponentsFromValuesWithScales } from "./covariance.js";
import {
  ellipsoidAreaFromScales,
  representativeSplatWeightFromScales,
  threeSigmaAabbBlendedRadiusFromExtents,
} from "./extents.js";

// Fills the planner's arrays of `core`, and the merge weights, opacity ×
// ellipsoid area, of the `count` splats in `records`. RAD supplies its cached
// weights and disables computeWeights.
export function loadCloud(
  records,
  count,
  core,
  mergeWeight,
  computeWeights = true,
) {
  const cloud = {
    length: count,
    minFeature: Number.POSITIVE_INFINITY,
    origin: [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
    positions: core.positions.subarray(0, count * 3),
    mergeWeight: mergeWeight.subarray(0, count),
    opacity: core.opacity.subarray(0, count),
    rgb: core.rgb.subarray(0, count * 3),
    covariance: core.covariance.subarray(0, count * 6),
    radius: core.radius.subarray(0, count),
    weight: core.weight.subarray(0, count),
  };
  const covariance = new Float64Array(6);
  const scales = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    const row = i * 16;
    for (let d = 0; d < 3; d++) {
      cloud.positions[i * 3 + d] = records[row + d];
      cloud.rgb[i * 3 + d] = Math.max(
        0,
        Math.min(1, 0.5 + ((records[row + 4 + d] - 0.5) / SH_C0) * 0.15),
      );
      cloud.origin[d] = Math.min(cloud.origin[d], records[row + d]);
    }
    cloud.opacity[i] = records[row + 3];
    covarianceComponentsFromValuesWithScales(
      records[row + 7],
      records[row + 8],
      records[row + 9],
      records[row + 10],
      records[row + 11],
      records[row + 12],
      records[row + 13],
      covariance,
      0,
      scales,
    );
    for (let d = 0; d < 6; d++) cloud.covariance[i * 6 + d] = covariance[d];
    cloud.minFeature = Math.min(
      cloud.minFeature,
      2 *
        Math.max(scales[0], scales[1], scales[2]) *
        opacityRadius(cloud.opacity[i]),
    );
    // In double precision and before the planner regularizes the
    // covariance: the blended radius of the box of three standard
    // deviations, from the variances along the axes, and the weights.
    cloud.radius[i] = threeSigmaAabbBlendedRadiusFromExtents(
      3.0 * Math.sqrt(Math.max(covariance[0], 1e-20)),
      3.0 * Math.sqrt(Math.max(covariance[3], 1e-20)),
      3.0 * Math.sqrt(Math.max(covariance[5], 1e-20)),
    );
    cloud.weight[i] = representativeSplatWeightFromScales(
      cloud.opacity[i],
      scales[0],
      scales[1],
      scales[2],
    );
    if (computeWeights)
      cloud.mergeWeight[i] =
        records[row + 3] *
        ellipsoidAreaFromScales(scales[0], scales[1], scales[2]);
  }
  return cloud;
}
