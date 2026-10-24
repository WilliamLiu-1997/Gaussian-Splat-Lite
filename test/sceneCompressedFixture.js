import { deflateSync, gzipSync } from "node:zlib";

// Independently specified synthetic source records, not exporter captures.
// Source 2 is transparent; range [1, 4) runs backwards along X.
const centers = [-7, 7, 1, -7, 7];
const labels = [4, 1, 3, 2, 0];

export function createRangeSpz() {
  const header = Buffer.alloc(16);
  header.write("NGSP");
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(centers.length, 8);
  header[12] = 4;
  header[13] = 12;
  const positions = Buffer.alloc(centers.length * 9);
  const rotations = Buffer.alloc(centers.length * 4);
  for (let i = 0; i < centers.length; i++) {
    positions.writeIntLE(centers[i] * 4096, i * 9, 3);
    rotations.writeUInt32LE(0xc0000000, i * 4);
  }
  return gzipSync(
    Buffer.concat([
      header,
      positions,
      Buffer.from([255, 255, 0, 255, 255]),
      Buffer.from([
        96, 128, 160, 112, 128, 144, 128, 128, 128, 144, 128, 112, 160, 128, 96,
      ]),
      Buffer.alloc(centers.length * 3, 144), // exp(144 / 16 - 10) = exp(-1).
      rotations,
      Buffer.from(
        Array.from(
          { length: centers.length * 72 },
          (_, i) => 32 + Math.floor(i / 72) * 20 + (i % 72),
        ),
      ),
    ]),
  );
}

function pngChunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}

function rgbaPng(width, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, ...pixels]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createRangeSog() {
  const palette = Buffer.alloc(960 * 4);
  for (let source = 0; source < centers.length; source++)
    for (let coefficient = 0; coefficient < 15; coefficient++) {
      const offset = (labels[source] * 15 + coefficient) * 4;
      palette.set(
        [
          32 + source * 20 + coefficient * 3,
          33 + source * 20 + coefficient * 3,
          34 + source * 20 + coefficient * 3,
          255,
        ],
        offset,
      );
    }
  const codes = [0, 65535, 43690, 0, 65535];
  const metadata = {
    version: 2,
    count: centers.length,
    means: {
      mins: [-Math.log(8), 0, 0],
      maxs: [Math.log(8), 0, 0],
      files: ["lo.png", "hi.png"],
    },
    scales: { codebook: Array(256).fill(-1), files: ["scales.png"] },
    quats: { files: ["quats.png"] },
    sh0: {
      codebook: Array.from({ length: 256 }, (_, i) => (i - 128) / 128),
      files: ["sh0.png"],
    },
    shN: {
      bands: 3,
      count: centers.length,
      codebook: Array.from({ length: 256 }, (_, i) => (i - 128) / 128),
      files: ["centroids.png", "labels.png"],
    },
  };
  const assets = new Map([
    ["centroids.png", rgbaPng(960, palette)],
    [
      "lo.png",
      rgbaPng(
        5,
        codes.flatMap((code) => [code & 255, 0, 0, 255]),
      ),
    ],
    [
      "hi.png",
      rgbaPng(
        5,
        codes.flatMap((code) => [code >> 8, 0, 0, 255]),
      ),
    ],
    ["scales.png", rgbaPng(5, Buffer.alloc(20))],
    [
      "quats.png",
      rgbaPng(
        5,
        centers.flatMap(() => [128, 128, 128, 252]),
      ),
    ],
    [
      "sh0.png",
      rgbaPng(
        5,
        centers.flatMap((_, i) => [
          96 + i * 16,
          128,
          160 - i * 16,
          i === 2 ? 0 : 255,
        ]),
      ),
    ],
    [
      "labels.png",
      rgbaPng(
        5,
        labels.flatMap((label) => [label, 0, 0, 255]),
      ),
    ],
  ]);
  return { metadata: JSON.stringify(metadata), assets };
}
