import assert from "node:assert/strict";
import test from "node:test";
import { readLccFixture as read } from "./lccFixture.js";

const BLOCK = 262144;

for (const fileType of ["Portable", "Quality"]) {
  for (const [count, expected] of [
    [BLOCK - 1, [BLOCK - 1]],
    [BLOCK, [BLOCK]],
    [BLOCK + 1, [BLOCK, 1]],
    [2 * BLOCK, [BLOCK, BLOCK]],
    [2 * BLOCK + 1, [BLOCK, BLOCK, 1]],
    ...(fileType === "Quality"
      ? [[8_000_000, [...Array(30).fill(BLOCK), 135680]]]
      : []),
  ]) {
    test(`${fileType} chunk boundaries preserve whole Unit/LOD identity for ${count} points`, async (context) => {
      const offset = 320;
      const { model } = await read(context, {
        counts: [count],
        offsets: [offset],
        fileType,
      });
      const rep = model.units[0].representations[0];
      assert.equal(rep.id, "0:0");
      assert.equal(rep.count, count);
      assert.equal(model.coarseCount, count);
      assert.deepEqual(
        rep.ranges.map((range) => range.count),
        expected,
      );
      let first = 0;
      for (const range of rep.ranges) {
        const source = range.source;
        assert.equal(range.start, 0);
        assert.equal(range.node.index, 0);
        assert.equal(source.offset, offset + first * 32);
        assert.equal(source.byteLength, range.count * 32);
        assert.equal(source.sourceOffset, offset / 32 + first);
        assert.equal(source.count, range.count);
        assert.equal(source.maxPoints, range.count);
        assert.equal(source.context.count, range.count);
        assert.equal(source.context.maxPoints, range.count);
        assert.equal(source.context.fileType, fileType);
        assert.equal(source.context.environment, false);
        assert.equal(
          source.shOffset,
          fileType === "Quality" ? (offset / 32 + first) * 64 : undefined,
        );
        assert.equal(
          source.shByteLength,
          fileType === "Quality" ? range.count * 64 : undefined,
        );
        assert.equal(
          source.inputBytes,
          range.count * (fileType === "Quality" ? 96 : 32),
        );
        assert.notEqual(source.wholeFile, true);
        first += range.count;
      }
      assert.equal(
        new Set(rep.ranges.map((range) => range.source.key)).size,
        expected.length,
      );
    });
  }
}

test("Quality chunks keep exact base/SH offsets above 4 GiB and contiguous global source IDs", async (context) => {
  const offset = 2 ** 32 + 96;
  const { model } = await read(context, {
    counts: [BLOCK + 3],
    offsets: [offset],
  });
  const [first, last] = model.units[0].representations[0].ranges.map(
    (range) => range.source,
  );
  assert.equal(first.offset, 4294967392);
  assert.equal(first.shOffset, 8589934784);
  assert.equal(first.sourceOffset, 134217731);
  assert.equal(last.offset, 4303356000);
  assert.equal(last.shOffset, 8606712000);
  assert.equal(last.sourceOffset, 134479875);
  assert.equal(first.sourceOffset + first.count, last.sourceOffset);
  assert.equal(last.count, 3);
  assert.equal(last.byteLength, 96);
  assert.equal(last.shByteLength, 192);
});

for (const fileType of ["Portable", "Quality"]) {
  for (const [count, expected] of [
    [BLOCK, [BLOCK]],
    [BLOCK + 1, [BLOCK, 1]],
    [2 * BLOCK + 3, [BLOCK, BLOCK, 3]],
  ]) {
    test(`${fileType} environment chunks use record IDs and ${fileType === "Quality" ? 96 : 32}-byte offsets for ${count} points`, async (context) => {
      const stride = fileType === "Quality" ? 96 : 32;
      const { model } = await read(context, {
        counts: [0],
        fileType,
        environmentCount: count,
      });
      assert.equal(model.environment.id, "environment");
      assert.equal(model.environment.count, count);
      assert.deepEqual(
        model.environment.ranges.map((range) => range.count),
        expected,
      );
      let first = 0;
      for (const range of model.environment.ranges) {
        const source = range.source;
        assert.equal(source.offset, first * stride);
        assert.equal(source.sourceOffset, first);
        assert.equal(source.byteLength, range.count * stride);
        assert.equal(source.inputBytes, range.count * stride);
        assert.equal(source.shOffset, undefined);
        assert.equal(source.shByteLength, undefined);
        assert.equal(source.context.environment, true);
        assert.equal(source.context.count, range.count);
        assert.equal(source.context.maxPoints, range.count);
        assert.deepEqual(source.context.scaleMin, [10, 20, 30]);
        if (fileType === "Quality")
          assert.deepEqual(source.context.shMin, [-4, -5, -6]);
        assert.equal(source.wholeFile, count <= BLOCK);
        first += range.count;
      }
      assert.equal(first, count);
    });
  }
}

test("resource version and full-file length seeds survive every base, SH and environment block", async (context) => {
  const { model, dataSize, shSize, environmentSize } = await read(context, {
    counts: [BLOCK + 1],
    environmentCount: BLOCK + 1,
    probe: true,
  });
  const ranges = model.units[0].representations[0].ranges;
  for (const { source } of ranges) {
    assert.equal(source.resourceState, ranges[0].source.resourceState);
    assert.equal(source.resourceState.total, dataSize);
    assert.equal(source.resourceState.validator, '"chunks-v1"');
    assert.equal(source.shResourceState, ranges[0].source.shResourceState);
    assert.equal(source.shResourceState.total, shSize);
    assert.equal(source.shResourceState.validator, '"chunks-v1"');
  }
  const environment = model.environment.ranges;
  for (const { source } of environment) {
    assert.equal(source.resourceState, environment[0].source.resourceState);
    assert.equal(source.resourceState.total, environmentSize);
    assert.equal(source.resourceState.validator, '"chunks-v1"');
    assert.equal(source.wholeFile, false);
  }
});

test("chunking retains full-representation count, eager environment and 32-bit source-ID validation", async (context) => {
  await assert.rejects(
    read(context, { counts: [8_000_001, 1] }),
    /source count/,
  );
  await assert.rejects(
    read(context, { counts: [2], offsets: [(2 ** 32 - 1) * 32] }),
    /source IDs exceed 32-bit/,
  );
  await assert.rejects(
    read(context, {
      counts: [0],
      environmentCount: BLOCK + 1,
      missingEnvironmentSh: true,
    }),
    /missing Quality SH range/,
  );
  const { model } = await read(context, {
    counts: [1],
    offsets: [(2 ** 32 - 1) * 32],
  });
  assert.equal(
    model.units[0].representations[0].ranges[0].source.sourceOffset,
    2 ** 32 - 1,
  );
});
