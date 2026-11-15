import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeWebp, initializeWebp } from "../bin/sog/webp.js";
import {
  SogDecodeSession,
  initSync,
} from "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs.js";

initSync({
  module: readFileSync(
    new URL(
      "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
      import.meta.url,
    ),
  ),
});
await initializeWebp();

const codebook = Array(256).fill(0);
function decodeImage(image, count) {
  // Blind data exposes the decoded RGBA bytes without SOG quantization.
  const session = new SogDecodeSession(
    JSON.stringify({
      version: 3,
      count,
      means: {
        mins: [0, 0, 0],
        maxs: [1, 1, 1],
        files: ["data.webp", "data.webp"],
      },
      scales: { codebook, files: ["data.webp"] },
      quats: { files: ["data.webp"] },
      sh0: { codebook, files: ["data.webp"] },
      blind: [
        { files: ["data.webp"], fields: [{ name: "rgba", type: "u32" }] },
      ],
    }),
    0,
    true,
  );
  let consumed = false;
  try {
    for (const group of JSON.parse(session.plan())) {
      for (const _ of group) session.decode_asset([image], 0, image.length, -1);
      while (!session.decode_batch()) {}
    }
    consumed = true;
    const { blindData } = session.finish();
    return new Uint8Array(blindData[0].buffer);
  } finally {
    if (!consumed) session.free();
  }
}

const rgba = new Uint8Array([
  19, 101, 233, 0, 0, 255, 128, 1, 255, 64, 0, 127, 12, 34, 56, 255,
]);
const image = encodeWebp(rgba, 2, 2);
assert.deepEqual(decodeImage(image, 4), rgba);

// Preserve the image decoder checks previously run inside Rust.
const padded = new Uint8Array(512 * 512 * 4).fill(255);
assert.deepEqual(decodeImage(encodeWebp(padded, 512, 512), 512 * 512), padded);
const truncated = new Uint8Array([
  82, 73, 70, 70, 18, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 5, 0, 0, 0, 47,
  255, 195, 255, 0, 0,
]);
assert.throws(() => decodeImage(truncated, 1), /WebP/);
console.log(
  "WebP RGB/RGBA decoding and SOG round-trip passed, including transparent RGB and truncated input.",
);
