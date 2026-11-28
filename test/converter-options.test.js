import assert from "node:assert/strict";
import test from "node:test";
import {
  conversionFlags,
  conversionOptions,
} from "../converter/convert-options.js";

test("optional browser flags preserve SOG defaults and explicit zero", () => {
  const options = (flags) =>
    conversionOptions("sog", "in.ply", "out", conversionFlags("sog", 4, flags));
  assert.deepEqual(options({ "root-splats": undefined, "lod-density": 0 }), {
    ...options({}),
    lodDensity: 0,
  });
});

test("browser flags reject format mismatches and string booleans", () => {
  const options = (flags) =>
    conversionOptions("rad", "in.ply", "out", conversionFlags("rad", 4, flags));
  assert.throws(
    () => options({ "sog-blind": ["temperature:f32"] }),
    /sog-blind/,
  );
  assert.throws(() => options({ "rad-chunked": "false" }), /boolean/);
  assert.throws(() => options({ "max-sh": false }), /--max-sh/);
  assert.equal(options({ "rad-chunked": false }).chunked, false);
  assert.throws(() => options(new Map([["rad-chunked", true]])), /flags must/);
  for (const value of ["id", [null], Array(1)])
    assert.throws(
      () => conversionFlags("sog", 4, { "sog-blind": value }),
      /--sog-blind/,
    );
});
