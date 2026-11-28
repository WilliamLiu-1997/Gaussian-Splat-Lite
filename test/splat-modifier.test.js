import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three";
import { SplatModifier, glslModifier } from "../src/rendering/SplatModifier.js";

test("modifier uniforms and cached GPU resources belong to one installation", () => {
  const options = {
    glsl: "color.a *= gain;",
    uniforms: { gain: { type: "float", value: 1 } },
  };
  let updates = 0;
  const a = new SplatModifier(options, () => updates++);
  const b = new SplatModifier(options, () => {});
  const uniforms = {};
  const shader = glslModifier("#define GSL_MODIFIER_HOOK", a, "Work", uniforms);
  assert.match(shader, /uniform float gslParam_gain/);
  a.setUniform("gain", 0.25);
  assert.equal(uniforms.gslParam_gain.value, 0.25);
  assert.equal(b.uniforms.gain.value, 1);
  assert.equal(a.version, 1);
  assert.equal(updates, 1);
  assert.throws(() => a.setUniform("missing", 1), /missing/);
  let disposed = 0;
  const make = () => ({
    dispose() {
      disposed++;
    },
  });
  assert.equal(a.resource("variant", make), a.resource("variant", make));
  a.dispose();
  a.dispose();
  assert.equal(disposed, 1);
});

test("original-center and seed storage is selected for the active shader language", () => {
  const make = (options) => new SplatModifier(options, () => {});
  assert.equal(make({ glsl: "center.y += 2.;" }).needsSourceData(false), false);
  assert.equal(
    make({ glsl: "center = originalCenter;" }).needsSourceData(false),
    true,
  );
  assert.equal(
    make({ glsl: "color.r = float(seed);" }).needsSourceData(true),
    true,
  );
  const both = make({ glsl: "scale *= 2.;", tsl() {} });
  assert.equal(both.needsSourceData(true), true);
  assert.equal(both.needsSourceData(false), false);
  assert.equal(
    make({ tsl() {}, sourceData: false }).needsSourceData(true),
    false,
  );
  assert.throws(
    () =>
      glslModifier(
        "#define GSL_MODIFIER_HOOK",
        make({ wgsl: "scale *= 2.;" }),
        "Render",
        {},
      ),
    /GLSL/,
  );
});

test("world-position uniforms preserve centimetres across a world grid boundary", () => {
  const point = new Vector3(6400127.495, -6400127.505, 0.003);
  const anchor = { type: "worldPosition", value: point };
  const options = { glsl: "centerLow += anchorLow;", uniforms: { anchor } };
  const binding = new SplatModifier(options);
  const other = new SplatModifier(options);
  const uniforms = {};
  glslModifier("#define GSL_MODIFIER_HOOK", binding, "Work", uniforms);
  const high = uniforms.gslParam_anchorHigh.value;
  const low = uniforms.gslParam_anchorLow.value;
  const previousHigh = high.clone();
  const previousLow = low.clone();
  const previous = point.clone();
  point.addScalar(0.01);
  binding.setUniform("anchor", point);
  // Model the actual uploads and subtraction on the GPU, including float32 rounding.
  const f = Math.fround;
  for (const axis of ["x", "y", "z"]) {
    const delta = f(
      f(high[axis] - previousHigh[axis]) +
        f(f(low[axis]) - f(previousLow[axis])),
    );
    assert.ok(Math.abs(delta - 0.01) < 0.0000001);
    assert.ok(
      Math.abs(f(high[axis]) + f(low[axis]) - point[axis]) < 0.00000005,
    );
  }
  assert.notEqual(high.x, previousHigh.x);
  assert.equal(f(point.x), f(previous.x));
  assert.deepEqual(other.uniforms.anchorLow.value, previousLow);
  assert.throws(() => binding.setUniform("anchorHigh", point), /Unknown/);
  assert.throws(
    () =>
      new SplatModifier({
        ...options,
        uniforms: { anchor, anchorLow: { type: "vec3", value: point } },
      }),
    /Conflicting/,
  );
  for (const field of ["originalCenterLow", "originalCenterHigh"]) {
    assert.ok(
      new SplatModifier({ glsl: `color.r = ${field}.x;` }).needsSourceData(
        false,
      ),
    );
  }
});
