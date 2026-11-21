// LOD math adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
const float = new Float32Array(1);
const bits = new Uint32Array(float.buffer);
export const HALF = new Float32Array(65536);
export const SCALE = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const exponent = (i >> 10) & 31;
  const fraction = i & 1023;
  const sign = i & 32768 ? -1 : 1;
  HALF[i] =
    exponent === 31
      ? fraction
        ? Number.NaN
        : sign * Number.POSITIVE_INFINITY
      : sign *
        (exponent ? 1 + fraction / 1024 : fraction / 1024) *
        2 ** (exponent ? exponent - 15 : -14);
  SCALE[i] = Math.exp(HALF[i]);
}

export function halfBits(value) {
  float[0] = value;
  const word = bits[0];
  const sign = (word >>> 16) & 32768;
  const exponent = (word >>> 23) & 255;
  let mantissa = word & 0x7fffff;
  if (exponent === 255) return sign | (mantissa ? 0x7e00 : 0x7c00);
  const e = exponent - 112;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    return (
      sign |
      ((mantissa + (2 ** (shift - 1) - 1) + ((mantissa >>> shift) & 1)) >>>
        shift)
    );
  }
  return (
    sign | ((e << 10) + ((mantissa + 4095 + ((mantissa >>> 13) & 1)) >>> 13))
  );
}
export function half(value) {
  return HALF[halfBits(value)];
}

// Converts a Float32Array directly from its bits, as halfBits() does.
export function halfArray(values, bits, count) {
  const words = new Uint32Array(values.buffer, values.byteOffset, count);
  for (let i = 0; i < count; i++) {
    const word = words[i];
    const sign = (word >>> 16) & 32768;
    const exponent = (word >>> 23) & 255;
    let mantissa = word & 0x7fffff;
    const e = exponent - 112;
    if (exponent === 255) bits[i] = sign | (mantissa ? 0x7e00 : 0x7c00);
    else if (e >= 31) bits[i] = sign | 0x7c00;
    else if (e > 0) {
      bits[i] =
        sign |
        ((e << 10) + ((mantissa + 4095 + ((mantissa >>> 13) & 1)) >>> 13));
    } else if (e < -10) bits[i] = sign;
    else {
      mantissa |= 0x800000;
      const shift = 14 - e;
      bits[i] =
        sign |
        ((mantissa + ((1 << (shift - 1)) - 1) + ((mantissa >>> shift) & 1)) >>>
          shift);
    }
  }
  return bits;
}
export function area(x, y, z) {
  return (
    4 *
    Math.PI *
    (((x * y) ** 1.6075 + (x * z) ** 1.6075 + (y * z) ** 1.6075) / 3) **
      (1 / 1.6075)
  );
}
export function opacityRadius(opacity) {
  return opacity > 1 ? Math.sqrt(1 + Math.E * Math.log(opacity)) : 1;
}

export function rotation(record, output) {
  const x = record[10];
  const y = record[11];
  const z = record[12];
  const w = record[13];
  output[0] = 1 - 2 * (y * y + z * z);
  output[1] = 2 * (x * y + z * w);
  output[2] = 2 * (x * z - y * w);
  output[3] = 2 * (x * y - z * w);
  output[4] = 1 - 2 * (x * x + z * z);
  output[5] = 2 * (y * z + x * w);
  output[6] = 2 * (x * z + y * w);
  output[7] = 2 * (y * z - x * w);
  output[8] = 1 - 2 * (x * x + y * y);
}

// A splat's shortest axis relative to its longest in merging and its search.
// Float32 search terms lose thinner variances; edge-on, this is still well
// under a pixel.
export const MIN_ASPECT = 1 / 512;

export function covariance(record, output, r) {
  rotation(record, r);
  const sx = SCALE[halfBits(record[7])];
  const sy = SCALE[halfBits(record[8])];
  const sz = SCALE[halfBits(record[9])];
  const floor = (Math.max(sx, sy, sz) * MIN_ASPECT) ** 2;
  const x = Math.max(floor, sx * sx);
  const y = Math.max(floor, sy * sy);
  const z = Math.max(floor, sz * sz);
  output[0] = r[0] * r[0] * x + r[3] * r[3] * y + r[6] * r[6] * z;
  output[1] = r[1] * r[1] * x + r[4] * r[4] * y + r[7] * r[7] * z;
  output[2] = r[2] * r[2] * x + r[5] * r[5] * y + r[8] * r[8] * z;
  output[3] = r[0] * r[1] * x + r[3] * r[4] * y + r[6] * r[7] * z;
  output[4] = r[0] * r[2] * x + r[3] * r[5] * y + r[6] * r[8] * z;
  output[5] = r[1] * r[2] * x + r[4] * r[5] * y + r[7] * r[8] * z;
}

export function determinant(m) {
  return (
    m[0] * (m[1] * m[2] - m[5] * m[5]) -
    m[3] * (m[3] * m[2] - m[5] * m[4]) +
    m[4] * (m[3] * m[5] - m[1] * m[4])
  );
}

// Jacobi diagonalization of a symmetric covariance. All scratch arrays are
// reused by the caller; merging millions of pairs does not allocate JS objects.
export function eigens(m, matrix, vectors, order) {
  matrix[0] = m[0];
  matrix[4] = m[1];
  matrix[8] = m[2];
  matrix[1] = matrix[3] = m[3];
  matrix[2] = matrix[6] = m[4];
  matrix[5] = matrix[7] = m[5];
  vectors.fill(0);
  vectors[0] = vectors[4] = vectors[8] = 1;
  // A relative tolerance keeps merged orientations independent of scene units.
  const eps = 1e-6 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]));
  for (let k = 0; k < 32; k++) {
    if (matrix[1] ** 2 + matrix[2] ** 2 + matrix[5] ** 2 <= eps ** 2) break;
    let p = 0;
    let q = 1;
    if (Math.abs(matrix[2]) > Math.abs(matrix[1])) q = 2;
    if (Math.abs(matrix[5]) > Math.abs(matrix[p * 3 + q])) {
      p = 1;
      q = 2;
    }
    const apq = matrix[p * 3 + q];
    if (Math.abs(apq) <= eps) break;
    const app = matrix[p * 3 + p];
    const aqq = matrix[q * 3 + q];
    const tau = (aqq - app) / (2 * apq);
    const t = (tau < 0 ? -1 : 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const r = 3 - p - q;
    const arp = matrix[r * 3 + p];
    const arq = matrix[r * 3 + q];
    matrix[p * 3 + p] = app - t * apq;
    matrix[q * 3 + q] = aqq + t * apq;
    matrix[r * 3 + p] = matrix[p * 3 + r] = c * arp - s * arq;
    matrix[r * 3 + q] = matrix[q * 3 + r] = s * arp + c * arq;
    matrix[p * 3 + q] = matrix[q * 3 + p] = 0;
    for (let row = 0; row < 3; row++) {
      const a = vectors[row * 3 + p];
      const b = vectors[row * 3 + q];
      vectors[row * 3 + p] = c * a - s * b;
      vectors[row * 3 + q] = s * a + c * b;
    }
  }
  order[0] = 0;
  order[1] = 1;
  order[2] = 2;
  order.sort((a, b) => matrix[b * 3 + b] - matrix[a * 3 + a]);
}

export function quaternion(r, out) {
  const trace = r[0] + r[4] + r[8];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out[10] = (r[5] - r[7]) / s;
    out[11] = (r[6] - r[2]) / s;
    out[12] = (r[1] - r[3]) / s;
    out[13] = s * 0.25;
  } else {
    let i = r[0] > r[4] ? 0 : 1;
    if (r[8] > r[i * 3 + i]) i = 2;
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    const s = Math.sqrt(1 + r[i * 3 + i] - r[j * 3 + j] - r[k * 3 + k]) * 2;
    out[10 + i] = s * 0.25;
    out[10 + j] = (r[i * 3 + j] + r[j * 3 + i]) / s;
    out[10 + k] = (r[i * 3 + k] + r[k * 3 + i]) / s;
    out[13] = (r[j * 3 + k] - r[k * 3 + j]) / s;
  }
}
