import { deflateSync, gunzipSync, gzipSync } from "node:zlib";
import { createRangeSog, createRangeSpz } from "./sceneCompressedFixture.js";

// Reuse the independent color/SH payloads (SPZ degree 4, SOG degree 3). Both nonzero ranges
// [1, 3) and [3, 5) reverse spatial order; transparent slots 0 and 2 stay put.
const centers = [
  [-7, -3, -1],
  [7, 3, 1],
  [-7, -3, -1],
  [7, 3, 1],
  [-7, -3, -1],
];
const alphas = [0, 64, 0, 192, 255];

// Replace only IDAT in the existing one-row RGBA PNG fixtures.
function withPixels(png, pixels) {
  const compressed = deflateSync(Buffer.from([0, ...pixels]));
  const chunk = Buffer.alloc(compressed.length + 12);
  chunk.writeUInt32BE(compressed.length);
  chunk.write("IDAT", 4);
  chunk.set(compressed, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(-12)]);
}

export function createSceneCodecFixture(codec) {
  const expected = centers.map((center, source) => ({
    center,
    scales: [-3, -2, -1].map((value) => Math.exp(value + source / 4)),
    opacity: alphas[source] / 255,
  }));
  const scaleCodes = centers.flatMap((_, source) => [
    112 + source * 4,
    128 + source * 4,
    144 + source * 4,
  ]);
  if (codec === "spz") {
    const bytes = gunzipSync(createRangeSpz());
    const rotations = Buffer.alloc(20);
    for (let source = 0; source < centers.length; source++) {
      centers[source].forEach((value, axis) =>
        bytes.writeIntLE(value * 4096, 16 + source * 9 + axis * 3, 3),
      );
      // SPZ v3: omitted component in bits 30..31, three sign/magnitude
      // fields in XYZW order. Recover the omitted positive unit component.
      const omitted = source % 4;
      let packed = omitted;
      const quaternion = [0, 0, 0, 0];
      for (let axis = 0; axis < 4; axis++) {
        if (axis === omitted) continue;
        const magnitude = 32 * (axis + 1) + 8 * source;
        const negative = (axis + source) % 2;
        packed = (packed << 10) | (negative << 9) | magnitude;
        quaternion[axis] =
          ((negative ? -1 : 1) * magnitude) / (511 * Math.SQRT2);
      }
      quaternion[omitted] = Math.sqrt(
        1 - quaternion.reduce((sum, value) => sum + value * value, 0),
      );
      expected[source].quaternion = quaternion;
      rotations.writeUInt32LE(packed >>> 0, source * 4);
    }
    bytes.set(alphas, 16 + 5 * 9);
    bytes.set(scaleCodes, 16 + 5 * (9 + 1 + 3));
    bytes.set(rotations, 16 + 5 * (9 + 1 + 3 + 3));
    return { bytes: gzipSync(bytes), expected };
  }

  const fixture = createRangeSog();
  const metadata = JSON.parse(fixture.metadata);
  metadata.means.mins = [-Math.log(8), -Math.log(4), -Math.log(2)];
  metadata.means.maxs = metadata.means.mins.map((value) => -value);
  metadata.scales.codebook = Array.from(
    { length: 256 },
    (_, code) => code / 16 - 10,
  );
  const replace = (name, pixels) =>
    fixture.assets.set(name, withPixels(fixture.assets.get(name), pixels));
  const means = centers.flatMap((center) => [
    ...center.map((value) => (value > 0 ? 255 : 0)),
    255,
  ]);
  replace("lo.png", means);
  replace("hi.png", means);
  replace(
    "scales.png",
    centers.flatMap((_, source) => [
      ...scaleCodes.slice(source * 3, source * 3 + 3),
      255,
    ]),
  );
  replace(
    "sh0.png",
    centers.flatMap((_, source) => [
      96 + source * 16,
      128,
      160 - source * 16,
      alphas[source],
    ]),
  );
  replace(
    "quats.png",
    centers.flatMap((_, source) => {
      const codes = [96 + source * 4, 144 + source * 3, 176 - source * 5];
      // SOG: three signed components in [-1/sqrt(2), 1/sqrt(2)];
      // tags 252..255 select W, X, Y, Z as the omitted positive component.
      const [a, b, c] = codes.map((code) => (code / 255 - 0.5) * Math.SQRT2);
      const d = Math.sqrt(1 - a * a - b * b - c * c);
      expected[source].quaternion = [
        [a, b, c, d],
        [d, b, c, a],
        [b, d, c, a],
        [b, c, d, a],
      ][source % 4];
      return [...codes, 252 + (source % 4)];
    }),
  );
  return { ...fixture, metadata: JSON.stringify(metadata), expected };
}
