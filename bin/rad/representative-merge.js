import {
  covarianceComponentsFromValuesWithScales,
  covarianceToScaleQuat,
  makeCovarianceToScaleQuatScratch,
} from "../sog/voxel/covariance.js";
import { area, half } from "./math.js";
import { refresh } from "./splats.js";

// Accumulate a whole group before decomposing its covariance and rounding
// its RAD attributes. The representative chooses membership, not the center.
export class GroupMerger {
  constructor(records, weights, check) {
    this.records = records;
    this.weights = weights;
    this.check = check;
    this.record = new Float64Array(16);
    this.output = new Float32Array(16);
    this.covariance = new Float64Array(6);
    this.sums = new Float64Array(12);
    this.scratch = makeCovarianceToScaleQuatScratch();
  }

  run(rows, start, end) {
    const { records, weights, record, output, covariance, sums, scratch } =
      this;
    if (end - start === 1) {
      const at = rows[start] * 16;
      for (let d = 0; d < 16; d++) output[d] = records[at + d];
      return output;
    }
    sums.fill(0);
    let total = 0;
    for (let p = start; p < end; p++) {
      if ((p & 4095) === 0) this.check();
      const row = rows[p];
      for (let d = 0; d < 16; d++) record[d] = records[row * 16 + d];
      const weight = weights[row];
      const next = total + weight;
      if (!(weight > 0) || !Number.isFinite(next))
        throw new Error("Invalid splat merge weight");
      covarianceComponentsFromValuesWithScales(
        record[7],
        record[8],
        record[9],
        record[10],
        record[11],
        record[12],
        record[13],
        covariance,
      );
      const dx = record[0] - sums[0];
      const dy = record[1] - sums[1];
      const dz = record[2] - sums[2];
      const alpha = weight / next;
      sums[0] += alpha * dx;
      sums[1] += alpha * dy;
      sums[2] += alpha * dz;
      const ex = record[0] - sums[0];
      const ey = record[1] - sums[1];
      const ez = record[2] - sums[2];
      sums[3] += weight * (covariance[0] + dx * ex);
      sums[4] += weight * (covariance[1] + dx * ey);
      sums[5] += weight * (covariance[2] + dx * ez);
      sums[6] += weight * (covariance[3] + dy * ey);
      sums[7] += weight * (covariance[4] + dy * ez);
      sums[8] += weight * (covariance[5] + dz * ez);
      for (let d = 0; d < 3; d++) sums[9 + d] += weight * record[4 + d];
      total = next;
    }
    for (let d = 0; d < 6; d++) covariance[d] = sums[3 + d] / total;
    covarianceToScaleQuat(...covariance, output, 7, output, 10, scratch);
    output[3] = half(
      Math.max(
        1e-6,
        Math.min(
          1000,
          total /
            area(Math.exp(output[7]), Math.exp(output[8]), Math.exp(output[9])),
        ),
      ),
    );
    for (let d = 0; d < 3; d++) {
      output[d] = sums[d];
      output[4 + d] = half(sums[9 + d] / total);
    }
    for (let d = 7; d < 14; d++) output[d] = half(output[d]);
    refresh(output);
    for (const value of output)
      if (!Number.isFinite(value)) throw new Error("LOD splat overflow");
    return output;
  }
}
