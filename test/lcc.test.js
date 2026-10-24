import assert from "node:assert/strict";
import test from "node:test";
import {
  createLccDecodeContext,
  parseLccIndex,
  parseLccManifest,
} from "../src/loaders/lcc/lccManifest.js";

function fixture(fileType = "Portable") {
  return {
    version: "5.0",
    encoding: "COMPRESS",
    fileType,
    totalLevel: 2,
    indexDataSize: 36,
    totalSplats: 6,
    splats: [4, 2],
    cellLengthX: 10,
    cellLengthY: 20,
    offset: [0, 0, 0],
    shift: [0, 0, 0],
    scale: [1, 1, 1],
    epsg: 28992,
    boundingBox: { min: [-10, -20, -3], max: [20, 40, 7] },
    attributes: [
      { name: "scale", min: [0, 1, 2], max: [1, 3, 5] },
      { name: "shcoef", min: [-1, -2, -3], max: [2, 4, 6] },
      { name: "envscale", min: [10, 20, 30], max: [40, 50, 60] },
      { name: "envshcoef", min: [-4, -5, -6], max: [7, 8, 9] },
    ],
    custom: { preserved: true },
  };
}
function manifest(fileType = "Portable") {
  return parseLccManifest(JSON.stringify(fixture(fileType)));
}
function indexBytes(
  units = [
    {
      index: 0,
      levels: [
        [3, 0n],
        [1, 96n],
      ],
    },
    {
      index: 0xffff0001,
      levels: [
        [1, 128n],
        [1, 160n],
      ],
    },
  ],
) {
  const bytes = new Uint8Array(units.length * 36);
  const view = new DataView(bytes.buffer);
  units.forEach((unit, i) => {
    view.setUint32(i * 36, unit.index, true);
    unit.levels.forEach(([count, offset], level) => {
      const at = i * 36 + 4 + level * 16;
      view.setUint32(at, count, true);
      view.setBigUint64(at + 4, offset, true);
      view.setUint32(at + 12, count * 32, true);
    });
  });
  return bytes;
}
function rejects(edit, pattern, options) {
  const source = fixture();
  edit(source);
  assert.throws(
    () => parseLccManifest(JSON.stringify(source), options),
    pattern,
  );
}

test("LCC parses explicit Portable and Quality profiles and preserves metadata", () => {
  for (const fileType of ["Portable", "Quality"]) {
    const parsed = manifest(fileType);
    assert.equal(parsed.indexStride, 36);
    assert.equal(parsed.maxShDegree, fileType === "Quality" ? 3 : 0);
    assert.equal(parsed.environmentStride, fileType === "Quality" ? 96 : 32);
    assert.deepEqual(parsed.scaleRange, { min: [0, 1, 2], max: [1, 3, 5] });
    assert.equal(parsed.epsg, 28992);
    assert.deepEqual(parsed.custom, { preserved: true });
  }
  assert.equal(
    parseLccManifest(new TextEncoder().encode(JSON.stringify(fixture())))
      .fileType,
    "Portable",
  );
});

test("LCC bounds manifest bytes, levels, attributes and UTF-8", () => {
  const text = JSON.stringify(fixture());
  assert.throws(
    () => parseLccManifest(text, { maxManifestBytes: text.length - 1 }),
    /byte limit/,
  );
  assert.throws(
    () =>
      parseLccManifest(new TextEncoder().encode(text), { maxManifestBytes: 4 }),
    /byte limit/,
  );
  assert.throws(
    () => parseLccManifest('"é"', { maxManifestBytes: 3 }),
    /byte limit/,
  );
  assert.throws(() => parseLccManifest(new Uint8Array([0xff])), /encoded data/);
  assert.throws(() => parseLccManifest("{"), /invalid manifest JSON/);
  assert.throws(() => parseLccManifest("null"), /must be an object/);
  assert.throws(() => parseLccManifest("[]"), /must be an object/);
  assert.throws(() => parseLccManifest(fixture()), /JSON text/);
  assert.throws(
    () => parseLccManifest(text, { maxManifestBytes: 0 }),
    /safe integer/,
  );
  assert.throws(() => parseLccManifest(text, { maxLevels: 1 }), /level limit/);
  rejects((m) => {
    m.attributes = Array(65).fill(m.attributes[0]);
  }, /at most 64/);
});

test("LCC rejects unsupported profiles, stride and implicit fileType", () => {
  rejects((m) => {
    m.version = "4.0";
  }, /unsupported version/);
  rejects((m) => {
    m.encoding = "gzip";
  }, /unsupported encoding/);
  rejects((m) => {
    m.fileType = "quality";
  }, /explicitly specify/);
  rejects((m) => {
    m.fileType = undefined;
  }, /explicitly specify/);
  const legacy = fixture();
  legacy.fileType = undefined;
  assert.equal(
    parseLccManifest(JSON.stringify(legacy), { fileType: "Portable" }).fileType,
    "Portable",
  );
  assert.throws(
    () => parseLccManifest(JSON.stringify(fixture()), { fileType: "Quality" }),
    /conflicts/,
  );
  rejects((m) => {
    m.indexDataSize = 86;
  }, /expected 36/);
});

test("LCC rejects bad ranges, counts, grid sizes and unverified transforms", () => {
  rejects((m) => {
    m.boundingBox.min[0] = 100;
  }, /min exceeds max/);
  rejects((m) => {
    m.boundingBox.max[1] = 1e39;
  }, /float32-range/);
  rejects((m) => {
    m.cellLengthX = 0;
  }, /positive/);
  rejects((m) => {
    m.cellLengthY = -1;
  }, /positive/);
  rejects((m) => {
    m.totalLevel = 0;
  }, /safe integer/);
  rejects((m) => {
    m.splats = [6];
  }, /one count per level/);
  rejects((m) => {
    m.splats[0] = 0.5;
  }, /safe integer/);
  rejects((m) => {
    m.totalSplats = 7;
  }, /disagrees/);
  rejects((m) => {
    m.epsg = -1;
  }, /safe integer/);
  for (const key of ["offset", "shift", "scale"]) {
    rejects((m) => {
      m[key][0] += 1;
    }, /unsupported non-identity/);
  }
  rejects((m) => {
    m.attributes.push(m.attributes[0]);
  }, /duplicate/);
  rejects((m) => {
    m.attributes[0].min[0] = -1;
  }, /physical/);
  rejects((m) => {
    m.attributes[0].max[0] = -1;
  }, /min exceeds max/);
  rejects((m) => {
    m.attributes = [];
  }, /missing scale/);
  rejects((m) => {
    m.fileType = "Quality";
    m.attributes.splice(1, 1);
  }, /missing shcoef/);
});

test("LCC index parses unsigned packed Units and levels", () => {
  const parsed = parseLccIndex(indexBytes().buffer, manifest());
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].index, 0xffff0001);
  assert.equal(parsed[1].x, 1);
  assert.equal(parsed[1].y, 65535);
  assert.deepEqual(parsed[0].representations[1], {
    level: 1,
    count: 1,
    offset: 96,
    byteLength: 32,
    shOffset: undefined,
    shByteLength: undefined,
  });
  const padded = new Uint8Array(80);
  padded.set(indexBytes(), 3);
  assert.deepEqual(parseLccIndex(padded.subarray(3, 75), manifest()), parsed);
});

test("LCC index keeps offsets above 4 GiB exact and derives separate Quality ranges", () => {
  const bytes = indexBytes([
    {
      index: 0,
      levels: [
        [3, 0x100000000n],
        [1, 0x100000060n],
      ],
    },
    {
      index: 1,
      levels: [
        [1, 0x100000080n],
        [1, 0x1000000a0n],
      ],
    },
  ]);
  const units = parseLccIndex(bytes, manifest("Quality"));
  assert.equal(units[0].representations[0].offset, 4294967296);
  assert.equal(units[0].representations[0].shOffset, 8589934592);
  assert.equal(units[0].representations[0].shByteLength, 192);
});

test("LCC index rejects unsafe u64 base, end, SH offset and SH end arithmetic", () => {
  for (const [offset, profile, pattern] of [
    [0x20000000000000n, "Portable", /base offset.*safe/],
    [0x1fffffffffffe0n, "Portable", /base end.*safe/],
    [0x10000000000000n, "Quality", /SH offset.*safe/],
    [0xfffffffffffe0n, "Quality", /SH end.*safe/],
  ]) {
    const bytes = indexBytes();
    new DataView(bytes.buffer).setBigUint64(8, offset, true);
    assert.throws(() => parseLccIndex(bytes, manifest(profile)), pattern);
  }
});

test("LCC index rejects duplicates, wrong sizes, out-of-file ranges and count mismatches", () => {
  const m = manifest("Quality");
  assert.throws(
    () => parseLccIndex(indexBytes().subarray(1), m),
    /length\/stride/,
  );
  assert.throws(
    () => parseLccIndex(indexBytes(), m, { maxIndexBytes: 71 }),
    /byte limit/,
  );
  assert.throws(
    () => parseLccIndex(indexBytes(), m, { maxUnits: 1 }),
    /unit limit/,
  );
  assert.throws(
    () => parseLccIndex(indexBytes(), m, { maxUnits: -1 }),
    /safe integer/,
  );
  assert.throws(
    () => parseLccIndex(indexBytes(), m, { dataByteLength: 191 }),
    /exceeds data/,
  );
  assert.throws(
    () => parseLccIndex(indexBytes(), m, { shByteLength: 383 }),
    /exceeds SH/,
  );
  assert.doesNotThrow(() =>
    parseLccIndex(indexBytes(), m, { dataByteLength: 192, shByteLength: 384 }),
  );
  const duplicate = indexBytes();
  new DataView(duplicate.buffer).setUint32(36, 0, true);
  assert.throws(() => parseLccIndex(duplicate, m), /duplicate Unit/);
  const badSize = indexBytes();
  new DataView(badSize.buffer).setUint32(16, 95, true);
  assert.throws(() => parseLccIndex(badSize, m), /count \* 32/);
  const badAlignment = indexBytes();
  new DataView(badAlignment.buffer).setBigUint64(8, 1n, true);
  assert.throws(() => parseLccIndex(badAlignment, m), /record aligned/);
  assert.throws(
    () => parseLccIndex(indexBytes().slice(0, 36), m),
    /counts disagree/,
  );
  const tooMany = indexBytes();
  new DataView(tooMany.buffer).setUint32(4, 0xffffffff, true);
  assert.throws(() => parseLccIndex(tooMany, m), /count \* 32/);
});

test("LCC explicitly retains empty representations and accepts empty scenes", () => {
  const source = fixture();
  source.splats = [0, 2];
  source.totalSplats = 2;
  const m = parseLccManifest(JSON.stringify(source));
  const units = parseLccIndex(
    indexBytes([
      {
        index: 0,
        levels: [
          [0, 0n],
          [2, 0n],
        ],
      },
    ]),
    m,
  );
  assert.equal(units[0].representations[0].count, 0);
  assert.equal(units[0].representations[0].byteLength, 0);
  source.splats = [0, 0];
  source.totalSplats = 0;
  assert.deepEqual(
    parseLccIndex(new Uint8Array(), parseLccManifest(JSON.stringify(source))),
    [],
  );
});

test("LCC creates bounded native contexts with environment-specific quantization", () => {
  const m = manifest("Quality");
  const ordinary = createLccDecodeContext(m, 7);
  const env = createLccDecodeContext(m, 8, { environment: true, maxPoints: 8 });
  assert.equal(ordinary.version, "5.0");
  assert.equal(ordinary.encoding, "COMPRESS");
  assert.equal(ordinary.fileType, "Quality");
  assert.equal(ordinary.count, 7);
  assert.equal(ordinary.maxPoints, 1000000);
  assert.equal(ordinary.environment, false);
  assert.deepEqual(ordinary.scaleMin, [0, 1, 2]);
  assert.deepEqual(ordinary.shMax, [2, 4, 6]);
  assert.deepEqual(env.scaleMin, [10, 20, 30]);
  assert.deepEqual(env.shMax, [7, 8, 9]);
  assert.equal(env.environment, true);
  assert.throws(
    () => createLccDecodeContext(m, 9, { maxPoints: 8 }),
    /point limit/,
  );
  assert.throws(() => createLccDecodeContext(m, -1), /safe integer/);
  assert.throws(
    () => createLccDecodeContext(m, 1, { environment: "yes" }),
    /boolean/,
  );
  const noEnv = { ...m, environmentScaleRange: undefined };
  assert.throws(
    () => createLccDecodeContext(noEnv, 1, { environment: true }),
    /environment scale/,
  );
  const noEnvSh = { ...m, environmentShRange: undefined };
  assert.throws(
    () => createLccDecodeContext(noEnvSh, 1, { environment: true }),
    /Quality SH/,
  );
  const portable = createLccDecodeContext(manifest(), 0);
  assert.equal(portable.shMin, undefined);
  assert.equal(portable.shMax, undefined);
});
