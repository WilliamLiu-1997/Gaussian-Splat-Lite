import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";

const glue = new URL(
  "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs.js",
  import.meta.url,
);
const binary = new URL(
  "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
  import.meta.url,
);
const available = existsSync(glue) && existsSync(binary);
const metadata = JSON.stringify({
  version: 2,
  count: 1,
  means: { mins: [0, 0, 0], maxs: [0, 0, 0], files: ["lo.png", "hi.png"] },
  scales: { codebook: Array(256).fill(0), files: ["scales.png"] },
  quats: { files: ["quats.png"] },
  sh0: { codebook: Array(256).fill(0), files: ["sh0.png"] },
});

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "ascii");
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

function grayscalePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // One-bit grayscale expands to one byte per pixel.
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width / 8 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "SOG WASM32 scratch estimates do not reject valid grayscale PNG dimensions",
  { skip: !available, timeout: 30_000 },
  async (t) => {
    const wasm = await import(glue.href);
    wasm.initSync({ module: await readFile(binary) });
    for (const width of [4096, 8192]) {
      const png = grayscalePng(width, 4096);
      await t.test(`${width}x4096 without a budget`, () => {
        const session = new wasm.SogDecodeSession(metadata);
        try {
          assert.doesNotThrow(() => session.decode_asset([png], 0, 0, -1));
        } finally {
          session.free();
        }
      });
      if (width === 8192) {
        await t.test(
          "finite budget still rejects excessive image scratch",
          () => {
            const session = new wasm.SogDecodeSession(
              metadata,
              1,
              64 * 1024 ** 2,
            );
            try {
              assert.throws(
                () => session.decode_asset([png], 0, 0, -1),
                /Decoder memory budget exceeded/,
              );
            } finally {
              session.free();
            }
          },
        );
      }
    }
  },
);
