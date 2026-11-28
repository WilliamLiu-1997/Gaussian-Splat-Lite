import assert from "node:assert/strict";
import test from "node:test";
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
