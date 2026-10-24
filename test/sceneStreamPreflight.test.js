import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  preflightScenePayload,
  validateSceneDecodedSource,
} from "../src/loaders/stream/scene-stream/preflight.js";

function legacySpz(count = 3, version = 3, degree = 0) {
  const stride =
    (version === 1 ? 6 : 9) +
    1 +
    3 +
    3 +
    (version >= 3 ? 4 : 3) +
    3 * degree * (degree + 2);
  const bytes = new Uint8Array(16 + count * stride);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  bytes[12] = degree;
  bytes[13] = 12;
  return bytes;
}

test("PLY preflight uses native whitespace rules and bounds every element", async () => {
  const bytes = (lines) =>
    new TextEncoder().encode(
      `ply\nformat binary_little_endian 1.0\n${lines}\nend_header\n`,
    );
  for (const lines of [
    "  element\tvertex\t+2  \nproperty float x",
    "comment end_header is not the terminator\nelement vertex 2\nproperty float x",
  ])
    assert.equal(await preflightScenePayload(bytes(lines), "ply", 2), 2);
  const binary = Buffer.concat([
    bytes("element vertex 2"),
    Buffer.from([255, 254]),
  ]);
  assert.equal(await preflightScenePayload(binary, "ply", 2), 2);
  await assert.rejects(
    preflightScenePayload(
      bytes(
        "  element vertex 8000001\nproperty float x\n  end_header\nelement vertex 1",
      ),
      "ply",
      1,
    ),
    /source count limit/,
  );
  await assert.rejects(
    preflightScenePayload(
      bytes("element vertex 1\nelement vertex 2"),
      "ply",
      1,
    ),
    /Duplicate PLY/,
  );
  await assert.rejects(
    preflightScenePayload(
      bytes("element vertex 1\nelement chunk 8000001"),
      "ply",
      1,
    ),
    /source count limit/,
  );
});

// This minimal ZIP exercises preflight output bounds; the payload decoder separately validates CRC.
function metadataZip(compressed, declaredSize) {
  const name = new TextEncoder().encode("meta.json");
  const local = new Uint8Array(30 + name.length);
  const header = new DataView(local.buffer);
  header.setUint32(0, 0x04034b50, true);
  header.setUint16(4, 20, true);
  header.setUint16(8, 8, true);
  header.setUint32(18, compressed.length, true);
  header.setUint32(22, declaredSize, true);
  header.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const directory = new DataView(central.buffer);
  directory.setUint32(0, 0x02014b50, true);
  directory.setUint16(4, 20, true);
  directory.setUint16(6, 20, true);
  directory.setUint16(10, 8, true);
  directory.setUint32(20, compressed.length, true);
  directory.setUint32(24, declaredSize, true);
  directory.setUint16(28, name.length, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, 1, true);
  footer.setUint16(10, 1, true);
  footer.setUint32(12, central.length, true);
  footer.setUint32(16, local.length + compressed.length, true);
  return Buffer.concat([local, compressed, central, end]);
}

test("legacy SPZ preflight drains bounded output and checks gzip trailers", async () => {
  for (const version of [1, 2, 3]) {
    assert.equal(
      await preflightScenePayload(gzipSync(legacySpz(3, version)), "spz", 3),
      3,
    );
  }
  const truncated = gzipSync(legacySpz().subarray(0, 16));
  await assert.rejects(
    preflightScenePayload(truncated, "spz", 3),
    /Truncated SPZ record/,
  );
  const corrupt = gzipSync(legacySpz());
  corrupt[corrupt.length - 8] ^= 1;
  await assert.rejects(preflightScenePayload(corrupt, "spz", 3));
});

test("SPZ preflight bounds inflated extensions and rejects a corrupt ISIZE trailer", async () => {
  const payload = legacySpz(1);
  const bomb = gzipSync(
    Buffer.concat([payload, Buffer.alloc(1024 * 1024 + 1)]),
  );
  await assert.rejects(
    preflightScenePayload(bomb, "spz", 1),
    /inflated output exceeds/,
  );
  const allowed = gzipSync(Buffer.concat([payload, Buffer.alloc(64)]));
  assert.equal(await preflightScenePayload(allowed, "spz", 1), 1);
  allowed.writeUInt32LE(payload.length, allowed.length - 4);
  await assert.rejects(
    preflightScenePayload(allowed, "spz", 1),
    (error) =>
      error instanceof TypeError ||
      (error instanceof Error &&
        error.code === "Z_DATA_ERROR" &&
        /incorrect length check/.test(error.message)),
  );
});

test("SOG inflation cannot exceed the ZIP entry's declared size or metadata cap", async () => {
  const compressed = deflateRawSync(Buffer.alloc(2 * 1024 * 1024, 32));
  await assert.rejects(
    preflightScenePayload(metadataZip(compressed, 2), "sog", 1),
    /byte limit/,
  );
  await assert.rejects(
    preflightScenePayload(metadataZip(compressed, 2 * 1024 * 1024), "sog", 1),
    /exceeds 1 MiB/,
  );
});

test(
  "preflight cancellation stops a pending gzip drain",
  { timeout: 1000 },
  async () => {
    const controller = new AbortController();
    const pending = preflightScenePayload(
      gzipSync(legacySpz(100000)),
      "spz",
      1,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  },
);

test("source-order validation rejects filtered counts and incomplete or duplicate maps", () => {
  validateSceneDecodedSource({ numSplats: 3 }, 3);
  assert.throws(
    () => validateSceneDecodedSource({ numSplats: 2 }, 3),
    /count disagrees/,
  );
  for (const sourceIds of [
    new Uint32Array([0, 1]),
    new Uint32Array([0, 0, 2]),
    new Uint32Array([0, 1, 3]),
  ])
    assert.throws(
      () => validateSceneDecodedSource({ numSplats: 3, sourceIds }, 3),
      /complete source permutation/,
    );
  const sourceIds = new Uint32Array([2, 0, 1]);
  validateSceneDecodedSource({ numSplats: 3, sourceIds }, 3);
  assert.deepEqual(sourceIds, new Uint32Array([2, 0, 1]));
});

test("SPZ and PLY preflight reject source-count bombs before decode", async () => {
  const header = new Uint8Array(32);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 8, true);
  assert.equal(await preflightScenePayload(header, "spz", 8), 8);
  await assert.rejects(
    preflightScenePayload(header, "spz", 9),
    /exceeds source header/,
  );
  view.setUint32(8, 0xffffffff, true);
  await assert.rejects(preflightScenePayload(header, "spz", 1), /source count/);
  const ply = new TextEncoder().encode(
    "ply\nformat binary_little_endian 1.0\nelement vertex 900000000\nend_header\n",
  );
  await assert.rejects(preflightScenePayload(ply, "ply", 1), /source count/);
});

test("SOG preflight bounds metadata and reads the full source count before extraction", async () => {
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  assert.equal(
    await preflightScenePayload(encode({ version: 2, count: 12 }), "sog", 7),
    12,
  );
  assert.equal(
    await preflightScenePayload(
      encode({ means: { shape: [12, 3] } }),
      "sog",
      7,
    ),
    12,
  );
  await assert.rejects(
    preflightScenePayload(encode({ version: 2, count: 1e12 }), "sog", 7),
    /source count/,
  );
  await assert.rejects(
    preflightScenePayload(encode({ version: 2, count: 3 }), "sog", 7),
    /exceeds source header/,
  );
  await assert.rejects(
    preflightScenePayload(new Uint8Array(1024 * 1024 + 1), "sog", 1),
    /exceeds 1 MiB/,
  );
});

test("oversized PLY/SPZ/SOG headers fail maxPoints before decoding", async () => {
  const spz = new Uint8Array(32);
  const view = new DataView(spz.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 5000, true);
  const ply = new TextEncoder().encode(
    "ply\nformat binary_little_endian 1.0\nelement vertex 5000\nproperty float x\nend_header\n",
  );
  for (const [codec, bytes] of [
    ["ply", ply],
    ["spz", spz],
    ["spz", gzipSync(legacySpz(5000))],
    [
      "sog",
      new TextEncoder().encode(JSON.stringify({ version: 2, count: 5000 })),
    ],
  ])
    await assert.rejects(
      preflightScenePayload(bytes, codec, 1, undefined, { maxPoints: 1 }),
      /requires 5000 points/,
    );
});
