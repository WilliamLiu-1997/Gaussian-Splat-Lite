import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import test from "node:test";
import * as wasm from "gaussian-splat-rs";
import { decodeShRgbToArray } from "../src/data/splatCodec.js";
import { decodeSplat } from "../src/data/unpack.js";
import { loadSog } from "../src/loaders/sog.js";

const plyPath = process.env.PLY_SAMPLE;
const sogPath = process.env.SOG_SAMPLE;
function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected}`,
  );
}
function bounds(data) {
  const words = data.splat0;
  const values = new Float32Array(words.buffer, words.byteOffset, words.length);
  const min = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max = min.map(() => Number.NEGATIVE_INFINITY);
  for (let index = 0; index < data.numSplats; index++)
    for (let axis = 0; axis < 3; axis++) {
      const value = values[index * 4 + axis];
      assert.ok(Number.isFinite(value), "reference positions must be finite");
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  return { min, max };
}

// PLY_SAMPLE and SOG_SAMPLE are exact private file paths; supply matching exports when using both.
// Run with --expose-gc to release each full model promptly.
test(
  "genuine XGRIDS references match PLY source attributes and decode optional SOG",
  { skip: !plyPath && !sogPath, timeout: 120000 },
  async (context) => {
    await wasm.default({
      module_or_path: await readFile(
        new URL(
          "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
          import.meta.url,
        ),
      ),
    });
    assert.equal(
      wasm.decoder_budget_supported(),
      true,
      "Rebuild WASM before reference checks",
    );
    let count;
    let plyBounds;
    await context.test(
      "streamed PLY decoding matches independently read source records",
      { skip: !plyPath },
      async () => {
        const file = await open(plyPath, "r");
        let sampleRecords;
        try {
          const prefix = Buffer.alloc(65536);
          await file.read(prefix, 0, prefix.length, 0);
          const end = prefix.indexOf("end_header\n");
          assert.ok(end >= 0);
          const header = prefix.subarray(0, end + 11).toString("utf8");
          assert.match(header, /format binary_little_endian 1.0/);
          count = Number(/^element vertex (\d+)$/m.exec(header)[1]);
          const fields = [...header.matchAll(/^property float (\S+)$/gm)].map(
            (match) => match[1],
          );
          assert.equal(
            (await file.stat()).size,
            Buffer.byteLength(header) + count * fields.length * 4,
          );
          sampleRecords = await Promise.all(
            Array.from({ length: 16 }, async (_, ordinal) => {
              const index = Math.floor(((count - 1) * ordinal) / 15);
              const bytes = Buffer.alloc(fields.length * 4);
              await file.read(
                bytes,
                0,
                bytes.length,
                Buffer.byteLength(header) + index * bytes.length,
              );
              return {
                index,
                values: Object.fromEntries(
                  fields.map((field, offset) => [
                    field,
                    bytes.readFloatLE(offset * 4),
                  ]),
                ),
              };
            }),
          );
        } finally {
          await file.close();
        }
        const decoder = wasm.decode_to_splats(
          "ply",
          plyPath,
          count,
          2 * 1024 ** 3,
          256 * 1024 ** 2,
        );
        let consumed = false;
        try {
          const { size } = await stat(plyPath);
          decoder.set_expected_input_size(size);
          for await (const bytes of createReadStream(plyPath, {
            highWaterMark: 1024 * 1024,
          }))
            decoder.push(bytes);
          consumed = true;
          const data = decoder.finish();
          assert.equal(data.numSplats, count);
          assert.equal(data.maxShDegree, 3);
          for (const { index, values: source } of sampleRecords) {
            const actual = decodeSplat([data.splat0, data.splat1], index);
            for (const [axis, name] of ["x", "y", "z"].entries()) {
              close(
                actual.center.getComponent(axis),
                source[name],
                1e-6,
                `source ${index} ${name}`,
              );
              const scale = Math.exp(source[`scale_${axis}`]);
              close(
                actual.scales.getComponent(axis),
                scale,
                Math.max(1e-6, scale * 0.01),
                `source ${index} scale ${axis}`,
              );
            }
            close(
              actual.opacity,
              1 / (1 + Math.exp(-source.opacity)),
              0.001,
              `source ${index} alpha`,
            );
            const expectedQuat = [
              source.rot_1,
              source.rot_2,
              source.rot_3,
              source.rot_0,
            ];
            const norm = Math.hypot(...expectedQuat);
            if (norm > 0)
              assert.ok(
                Math.abs(
                  actual.quaternion
                    .toArray()
                    .reduce(
                      (sum, value, axis) =>
                        sum + (value * expectedQuat[axis]) / norm,
                      0,
                    ),
                ) > 0.999,
                `source ${index} quaternion`,
              );
            for (let coefficient = 0; coefficient < 15; coefficient++) {
              const actualSh = [0, 0, 0];
              const expected = [0, 1, 2].map(
                (channel) => source[`f_rest_${channel * 15 + coefficient}`],
              );
              decodeShRgbToArray(
                data[`shBlock${coefficient >> 2}`][
                  index * 4 + (coefficient & 3)
                ],
                actualSh,
              );
              const tolerance =
                1e-4 + Math.max(...expected.map(Math.abs)) * 0.01;
              expected.forEach((value, channel) =>
                close(
                  actualSh[channel],
                  value,
                  tolerance,
                  `source ${index} SH ${coefficient}/${channel}`,
                ),
              );
            }
          }
          plyBounds = bounds(data);
          assert.ok(wasm.wasm_memory_bytes() <= 256 * 1024 ** 2);
        } finally {
          if (!consumed) decoder.free();
        }
      },
    );
    globalThis.gc?.();
    await context.test(
      "SOG yields finite positions and SH3 metadata within budgets; matching PLY also checks count and bounds",
      { skip: !sogPath },
      async () => {
        const bytes = new Uint8Array(await readFile(sogPath));
        const data = await loadSog({
          fileBytes: bytes,
          pathName: sogPath,
          sendStatus() {},
          expectedSogCount: count,
          decoderLimits: {
            maxPoints: count ?? 0xffffffff,
            maxInputBytes: bytes.length,
            maxWasmBytes: 1024 ** 3,
            maxDecoderBytes: 2 * 1024 ** 3,
          },
        });
        assert.ok(data.numSplats > 0);
        assert.equal(data.maxShDegree, 3);
        const sogBounds = bounds(data);
        if (plyPath) {
          assert.equal(data.numSplats, count);
          for (const key of ["min", "max"])
            for (let axis = 0; axis < 3; axis++)
              close(
                sogBounds[key][axis],
                plyBounds[key][axis],
                0.001,
                `PLY/SOG ${key}/${axis}`,
              );
        }
        assert.ok(wasm.wasm_memory_bytes() <= 1024 ** 3);
      },
    );
    globalThis.gc?.();
  },
);
