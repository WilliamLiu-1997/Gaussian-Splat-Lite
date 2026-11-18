// RAD v1 encoding adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { HALF, half, halfBits, opacityRadius } from "./math.js";

// Fixed s8 range with SPZ's 1/128 SH step; -1 clips to -127/128.
export const SH_MAX = 127 / 128;

class Histogram {
  constructor() {
    this.counts = new Float64Array(65536);
    this.count = 0;
  }
  add(bits) {
    this.counts[bits & 32768 ? bits ^ 65535 : bits ^ 32768]++;
    this.count++;
  }
  percentile(fraction) {
    let rank = Math.min(
      this.count - 1,
      Math.round(Math.fround(Math.fround(this.count) * Math.fround(fraction))),
    );
    for (let i = 0; i < 65536; i++) {
      if (rank < this.counts[i]) return HALF[i & 32768 ? i ^ 32768 : i ^ 65535];
      rank -= this.counts[i];
    }
    throw new Error("Empty encoding histogram");
  }
}

export function alpha(value) {
  return value > 1
    ? half(Math.min(2, 1 + 0.25 * (opacityRadius(value) - 1)))
    : value;
}

// The base attributes that determine the encoding ranges.
export class EncodingRanges {
  constructor() {
    this.colors = new Histogram();
    this.scales = new Histogram();
    this.alphaF16 = false;
  }
  add(records) {
    for (let offset = 0; offset < records.length; offset += 16) {
      this.alphaF16 ||= alpha(records[offset + 3]) > 1;
      for (let d = 4; d <= 6; d++)
        this.colors.add(halfBits(records[offset + d]));
      const a = records[offset + 7];
      const b = records[offset + 8];
      const c = records[offset + 9];
      this.scales.add(
        halfBits(Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))),
      );
      this.scales.add(halfBits(Math.max(a, b, c)));
    }
  }
  format() {
    const { colors, scales } = this;
    const rgbMin = Math.min(0, colors.percentile(0.01));
    const rgbMax = Math.max(1, colors.percentile(0.99));
    const lnScaleMin = Math.min(
      -12,
      Math.max(Math.log(1e-30), scales.percentile(0.01)),
    );
    const lnScaleMax = Math.max(9, scales.percentile(0.99));
    return {
      alphaF16: this.alphaF16,
      rgbF16: rgbMin < -1 || rgbMax > 2,
      scaleF16: lnScaleMax - lnScaleMin > 25,
      meta: {
        rgbMin,
        rgbMax,
        lnScaleMin,
        lnScaleMax,
        sh1Max: SH_MAX,
        sh2Max: SH_MAX,
        sh3Max: SH_MAX,
        lodOpacity: true,
      },
    };
  }
}
