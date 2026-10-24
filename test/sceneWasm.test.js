import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeShRgbToArray } from "../src/data/splatCodec.js";
import { decodeSplat } from "../src/data/unpack.js";
import { reorderSplats } from "../src/loaders/morton.js";
import { sourceLimits } from "../src/loaders/stream/scene-stream/limits.js";
import { createSogStreamHandlers } from "../src/loaders/stream/sog-stream/workerHandlers.js";
import { createSharedPlyScene } from "./lcc2Fixture.js";
import { createSceneCodecFixture } from "./sceneCodecFixture.js";

const glue = new URL(
  "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs.js",
  import.meta.url,
);
const binary = new URL(
  "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
  import.meta.url,
);
const available = existsSync(glue) && existsSync(binary);
let instance = 0;
async function wasm() {
  const module = await import(`${glue.href}?conformance=${++instance}`);
  module.initSync({ module: await readFile(binary) });
  assert.equal(
    module.decoder_budget_supported(),
    true,
    "Rebuild WASM after decoder changes",
  );
  return module;
}

function assertPacked(data, count, degree) {
  assert.equal(data.numSplats, count);
  assert.equal(data.maxShDegree, degree);
  assert.ok(data.maxSplats >= count);
  for (const [name, Type, stride] of [
    ["splat0", Uint32Array, 4],
    ["splat1", Uint32Array, 4],
    ["sortCenters", Float32Array, 3],
    ...Array.from(
      { length: Math.ceil((degree * (degree + 2)) / 4) },
      (_, block) => [`shBlock${block}`, Uint32Array, 4],
    ),
  ]) {
    assert.ok(data[name] instanceof Type, `${name} type`);
    assert.equal(data[name].length, data.maxSplats * stride, `${name} length`);
  }
}

function assertSh(data, index, coefficient, expected, tolerance) {
  const actual = [0, 0, 0];
  decodeShRgbToArray(
    data[`shBlock${coefficient >> 2}`][index * 4 + (coefficient & 3)],
    actual,
  );
  expected.forEach((value, channel) =>
    assert.ok(
      Math.abs(actual[channel] - value) <= tolerance,
      `record ${index} SH ${coefficient}/${channel}: ${actual[channel]} != ${value}`,
    ),
  );
}

test(
  "built WASM preserves PLY record slots and SH under finite admission",
  { skip: !available },
  async () => {
    const module = await wasm();
    const { ply } = createSharedPlyScene();
    const limits = sourceLimits({ codec: "ply", count: 8, shDegree: 3 });
    const decoder = module.decode_to_splats(
      "ply",
      "shared.ply",
      limits.maxPoints,
      limits.maxDecoderBytes,
      limits.maxWasmBytes,
    );
    decoder.set_expected_input_size(ply.length);
    decoder.push(ply);
    const data = decoder.finish();
    assertPacked(data, 8, 3);
    for (let index = 0; index < 8; index++) {
      const splat = decodeSplat([data.splat0, data.splat1], index);
      assert.equal(splat.center.x, index - 3);
      assert.equal(splat.opacity, index === 0 ? 0 : 0.5);
      assert.ok(Math.abs(splat.scales.x - 0.04) < 0.005);
    }
    for (const index of [0, 7])
      for (const coefficient of [2, 3, 7, 8, 11, 12, 14]) {
        const expected = [0, 1, 2].map(
          (channel) => (channel * 15 + coefficient + 1) * (index + 1) * 0.001,
        );
        assertSh(
          data,
          index,
          coefficient,
          expected,
          0.00001 + expected[2] * 0.005,
        );
      }
    assert.ok(module.wasm_memory_bytes() <= limits.maxWasmBytes);
  },
);

for (const codec of ["spz", "sog"])
  test(
    `built WASM ${codec} retains two nonzero source ranges, transparent slots and all SH blocks through Morton extraction`,
    { skip: !available, timeout: 30_000 },
    async () => {
      const module = await wasm();
      const degree = codec === "spz" ? 4 : 3;
      const coefficients = degree * (degree + 2);
      const blocks = Math.ceil(coefficients / 4);
      const limits = sourceLimits({ codec, count: 5, shDegree: degree });
      const fixture = createSceneCodecFixture(codec);
      const checkRecord = (records, index, source) => {
        const splat = decodeSplat(records.splatArrays, index);
        const expected = fixture.expected[source];
        for (const [axis, value] of splat.center.toArray().entries())
          assert.ok(
            Math.abs(value - expected.center[axis]) < 0.00001,
            `source ${source} center ${axis}`,
          );
        assert.ok(Math.abs(splat.opacity - expected.opacity) < 0.0003);
        for (const [axis, value] of splat.scales.toArray().entries())
          assert.ok(
            Math.abs(value - expected.scales[axis]) < 0.001,
            `source ${source} scale ${axis}`,
          );
        const quaternion = splat.quaternion.toArray();
        const sign =
          quaternion.reduce(
            (dot, value, axis) => dot + value * expected.quaternion[axis],
            0,
          ) < 0
            ? -1
            : 1;
        for (const [axis, value] of quaternion.entries())
          assert.ok(
            Math.abs(sign * value - expected.quaternion[axis]) < 0.004,
            `source ${source} quaternion ${axis}`,
          );
        for (const [channel, code] of [
          96 + source * 16,
          128,
          160 - source * 16,
        ].entries()) {
          const color =
            codec === "spz"
              ? (code / 255 - 0.5) * (0.2820948 / 0.15) + 0.5
              : 0.5 + (0.2820948 * (code - 128)) / 128;
          assert.ok(Math.abs(splat.color.toArray()[channel] - color) < 0.001);
        }
        for (let coefficient = 0; coefficient < coefficients; coefficient++)
          assertSh(
            records.extra,
            index,
            coefficient,
            [0, 1, 2].map(
              (channel) =>
                (32 + source * 20 + coefficient * 3 + channel - 128) / 128,
            ),
            0.0021,
          );
        if (coefficients % 4)
          assert.equal(records.extra.shBlock3[index * 4 + 3], 0);
      };

      // Use real decoding and the package instance used by Morton/cache helpers.
      const sharedWasm = await import("gaussian-splat-rs");
      sharedWasm.initSync({ module: await readFile(binary) });
      let decodes = 0;
      const cache = createSogStreamHandlers(async () => {
        decodes++;
        let raw;
        if (codec === "spz") {
          const { bytes } = fixture;
          const decoder = module.decode_to_splats(
            "spz",
            "ranges.spz",
            limits.maxPoints,
            limits.maxDecoderBytes,
            limits.maxWasmBytes,
          );
          try {
            decoder.set_expected_input_size(bytes.length);
            for (let offset = 0; offset < bytes.length; offset += 7)
              decoder.push(bytes.subarray(offset, offset + 7));
          } catch (error) {
            decoder.free();
            throw error;
          }
          raw = decoder.finish();
        } else {
          const { metadata, assets } = fixture;
          const session = new module.SogDecodeSession(
            metadata,
            limits.maxPoints,
            limits.maxDecoderBytes,
            limits.maxWasmBytes,
          );
          try {
            for (const group of JSON.parse(session.plan())) {
              for (const name of group) {
                const png = assets.get(name);
                assert.ok(png, `missing fixture asset ${name}`);
                session.decode_asset(
                  [png.subarray(0, 11), png.subarray(11)],
                  0,
                  png.length,
                  -1,
                );
              }
              while (!session.decode_batch()) {}
            }
          } catch (error) {
            session.free();
            throw error;
          }
          raw = session.finish();
        }
        assertPacked(raw, 5, degree);
        const data = {
          numSplats: raw.numSplats,
          splatArrays: [raw.splat0, raw.splat1],
          sortCenters: raw.sortCenters,
          extra: Object.fromEntries(
            Array.from({ length: blocks }, (_, block) => [
              `shBlock${block}`,
              raw[`shBlock${block}`],
            ]),
          ),
        };
        for (let source = 0; source < 5; source++)
          checkRecord(data, source, source);
        assert.ok(module.wasm_memory_bytes() <= limits.maxWasmBytes);
        // The cache must restore this complete source permutation before slicing.
        reorderSplats(data);
        return data;
      });
      try {
        await cache.loadSogChunk({ id: codec });
        for (const [start, sources] of [
          [1, [2, 1]],
          [3, [4, 3]],
        ]) {
          const [range] = cache.extractSogRegions({
            id: codec,
            ranges: [{ start, count: 2 }],
          });
          assert.equal(range.numSplats, 2);
          assert.deepEqual(Array.from(range.sourceIds), sources);
          for (const [index, source] of sources.entries())
            checkRecord(range, index, source);
        }
        assert.equal(decodes, 1);
      } finally {
        cache.releaseSogChunk({ id: codec });
      }
    },
  );

test(
  "built WASM rejects excessive header/output admission before publication",
  { skip: !available },
  async () => {
    const module = await wasm();
    const { ply } = createSharedPlyScene();
    for (const [points, bytes, message] of [
      [7, 64 * 1024 ** 2, /maxPoints/],
      [8, 100, /memory budget/],
    ]) {
      const decoder = module.decode_to_splats(
        "ply",
        undefined,
        points,
        bytes,
        32 * 1024 ** 2,
      );
      try {
        decoder.set_expected_input_size(ply.length);
        assert.throws(() => decoder.push(ply), message);
      } finally {
        decoder.free();
      }
    }
  },
);

test(
  "built WASM accepts budgeted LCC Portable, Quality and environment contexts",
  { skip: !available },
  async () => {
    const module = await wasm();
    const base = new Uint8Array(32);
    new DataView(base.buffer).setFloat32(0, 1.25, true);
    base.set([128, 64, 255, 0], 12);
    const shSamples = [
      [3, 2047, [2, -2, -3]],
      [7, 1023 << 11, [-1, 4, -3]],
      [8, (2047 << 21) >>> 0, [-1, -2, 6]],
      [12, 0xffffffff, [2, 4, 6]],
    ];
    new DataView(base.buffer).setUint32(
      22,
      (512 | (512 << 10) | (512 << 20) | (3 << 30)) >>> 0,
      true,
    );
    for (const fileType of ["Portable", "Quality"])
      for (const environment of [false, true]) {
        const quality = fileType === "Quality";
        const sh = quality ? new Uint8Array(64) : new Uint8Array(0);
        if (quality)
          for (const [coefficient, word] of shSamples)
            new DataView(sh.buffer).setUint32(coefficient * 4, word, true);
        const input = environment ? new Uint8Array([...base, ...sh]) : base;
        const limits = sourceLimits({
          codec: "lcc",
          count: 1,
          shDegree: quality ? 3 : 0,
          inputBytes: base.length + sh.length,
        });
        const context = {
          version: "5.0",
          encoding: "COMPRESS",
          fileType,
          count: 1,
          environment,
          scaleMin: [0.1, 0.1, 0.1],
          scaleMax: [0.1, 0.1, 0.1],
          ...(quality ? { shMin: [-1, -2, -3], shMax: [2, 4, 6] } : {}),
          maxPoints: limits.maxPoints,
          maxDecoderBytes: limits.maxDecoderBytes,
          maxWasmBytes: limits.maxWasmBytes,
        };
        const data = module.decodeLcc(
          input,
          environment ? new Uint8Array(0) : sh,
          JSON.stringify(context),
        );
        assertPacked(data, 1, quality ? 3 : 0);
        const splat = decodeSplat([data.splat0, data.splat1], 0);
        assert.equal(splat.center.x, 1.25);
        assert.equal(splat.opacity, 0);
        assert.ok(Math.abs(splat.scales.x - 0.1) < 0.005);
        if (quality)
          for (const [coefficient, , expected] of shSamples)
            assertSh(data, 0, coefficient, expected, 0.02);
        assert.ok(module.wasm_memory_bytes() <= limits.maxWasmBytes);
      }
  },
);
