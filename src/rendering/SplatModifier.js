import { Vector3 } from "three";
import { splitWorldPosition } from "../utils/transforms.js";
import { N, uniformBinding } from "./tsl/shaderUtils.js";

const wgslTypes = {
  float: "f32",
  int: "i32",
  uint: "u32",
  bool: "bool",
  vec2: "vec2f",
  vec3: "vec3f",
  vec4: "vec4f",
  mat3: "mat3x3f",
  mat4: "mat4x4f",
};
const fields = [
  "center",
  "scale",
  "rotation",
  "color",
  "originalCenter",
  "centerHigh",
  "centerLow",
  "originalCenterHigh",
  "originalCenterLow",
  "seed",
];

/** A binding belongs to one mesh or renderer. Shader text is immutable. */
export class SplatModifier {
  constructor(options, onChange) {
    this.options = { ...options, uniforms: { ...options.uniforms } };
    this.uniforms = Object.create(null);
    this.positions = new Map();
    this.resources = new Map();
    this.version = 0;
    this.onChange = onChange;
    for (const [name, spec] of Object.entries(options.uniforms ?? {})) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ||
        fields.includes(name) ||
        /^(gl_|gsl)/i.test(name) ||
        (spec.type !== "worldPosition" && !Object.hasOwn(wgslTypes, spec.type))
      ) {
        throw new Error(`Invalid splat modifier uniform: ${name}`);
      }
      if (spec.type === "worldPosition") {
        const high = new Vector3();
        const low = new Vector3();
        for (const [suffix, value] of [
          ["High", high],
          ["Low", low],
        ]) {
          const key = name + suffix;
          if (Object.hasOwn(options.uniforms, key) || fields.includes(key))
            throw new Error(`Conflicting splat modifier uniform: ${key}`);
          this.uniforms[key] = { type: "vec3", value };
        }
        splitWorldPosition(spec.value, high, low);
        this.positions.set(name, { high, low });
      } else {
        this.uniforms[name] = { type: spec.type, value: spec.value };
      }
    }
    if (!options.glsl && !options.wgsl && !options.tsl)
      throw new Error("A splat modifier needs GLSL, WGSL or TSL");
  }
  // Parsed by GLSL itself on WebGL. Detect direct references conservatively;
  // the explicit toggle also covers token-pasting and TSL callbacks.
  needsSourceData(nodeBackend) {
    return (
      this.options.sourceData ??
      (nodeBackend && this.options.tsl
        ? true
        : /\b(originalCenter(?:High|Low)?|seed)\b/.test(
            this.options.glsl ?? "",
          ))
    );
  }
  setUniform(name, value) {
    if (!Object.hasOwn(this.options.uniforms, name))
      throw new Error(`Unknown splat modifier uniform: ${name}`);
    const position = this.positions.get(name);
    if (position) {
      splitWorldPosition(value, position.high, position.low);
    } else {
      const uniform = this.uniforms[name];
      if (typeof value !== "object" && uniform.value === value) return;
      uniform.value = value;
    }
    this.version++;
    this.onChange?.();
  }
  resource(key, create) {
    if (!this.resources.has(key)) this.resources.set(key, create());
    return this.resources.get(key);
  }
  dispose() {
    this.onChange = null;
    for (const value of this.resources.values()) value.dispose();
    this.resources.clear();
  }
}

function source(binding, stage, language) {
  const body = binding.options[language];
  if (typeof body !== "string")
    throw new Error(
      `The ${stage} splat modifier needs ${language.toUpperCase()} for this backend`,
    );
  const params = Object.entries(binding.uniforms);
  const name = `gsl${stage}Modifier`;
  const glsl = language === "glsl";
  const v3 = glsl ? "vec3" : "vec3f";
  const v4 = glsl ? "vec4" : "vec4f";
  const m4 = glsl ? "mat4" : "mat4x4f";
  const inputs = [
    ["gslRelative", "vec3"],
    ["gslScale", "vec3"],
    ["gslRotation", "vec4"],
    ["gslColor", "vec4"],
    ["gslOriginal", "vec3"],
    ["seed", "uint"],
    ["gslOrigin", "vec3"],
    ["gslOriginLow", "vec3"],
    ...params.map(([n, s]) => [n, s.type]),
  ];
  const args = inputs
    .map(([n, t]) => (glsl ? `${t} ${n}` : `${n}: ${wgslTypes[t]}`))
    .join(", ");
  const decl = glsl ? "vec3" : "let";
  const mut = glsl ? "vec3" : "var";
  // Form the small residual before adding the large part. Keep the unedited
  // relative center bit-exact, even when its magnitude is below one low-part ULP.
  return `${glsl ? `mat4 ${name}(${args})` : `fn ${name}(${args}) -> ${m4}`} {
    ${decl} gslLocal = gslRelative + gslOriginLow;
    ${decl} gslOrigLocal = gslOriginal + gslOriginLow;
    ${decl} gslHigh = gslOrigin + floor(gslLocal + ${v3}(0.5));
    ${decl} gslLow = ((gslOrigin - gslHigh) + gslRelative) + gslOriginLow;
    ${decl} originalCenterHigh = gslOrigin + floor(gslOrigLocal + ${v3}(0.5));
    ${decl} originalCenterLow = ((gslOrigin - originalCenterHigh) + gslOriginal) + gslOriginLow;
    ${decl} originalCenter = originalCenterHigh + originalCenterLow;
    ${decl} gslWorld = gslHigh + gslLow;
    ${mut} center = gslWorld;
    ${mut} centerHigh = gslHigh;
    ${mut} centerLow = gslLow;
    ${mut} scale = gslScale;
    ${glsl ? v4 : "var"} rotation = gslRotation;
    ${glsl ? v4 : "var"} color = gslColor;
    ${body}
    ${decl} gslMoved = ${glsl ? "mix" : "select"}(
      gslRelative + (centerLow - gslLow),
      (centerHigh - gslOrigin) + (centerLow - gslOriginLow),
      ${glsl ? "notEqual(centerHigh, gslHigh)" : "centerHigh != gslHigh"});
    return ${m4}(${v4}(gslMoved + (center - gslWorld), 0.0), ${v4}(scale, 0.0), rotation, color);
  }`;
}

/** Specialize the classic shader once. Values retain their per-binding uniform objects. */
export function glslModifier(shader, binding, stage, uniforms) {
  if (!binding)
    return shader.replace(
      "#define GSL_MODIFIER_HOOK",
      "#define GSL_SOURCE_DATA 0",
    );
  const params = Object.entries(binding.uniforms);
  for (const [name, spec] of params) uniforms[`gslParam_${name}`] = spec;
  return shader.replace(
    "#define GSL_MODIFIER_HOOK",
    () => `
    #define GSL_MODIFIER
    #define GSL_SOURCE_DATA ${Number(stage === "Render" && binding.needsSourceData(false))}
    uniform vec3 renderOriginHigh;
    uniform vec3 renderOriginLow;
    ${params.map(([n, s]) => `uniform ${s.type} gslParam_${n};`).join("\n")}
    ${source(binding, stage, "glsl")}
    #define GSL_APPLY(c,s,r,col,orig,id) gsl${stage}Modifier(c,s,r,col,orig,id,renderOriginHigh,renderOriginLow${params.map(([n]) => `,gslParam_${n}`).join("")})
  `,
  );
}

/** The same field contract is used by TSL and native shader bodies. */
export function nodeModifier(binding, stage, language, uniforms) {
  if (!binding) return null;
  const params = Object.fromEntries(
    Object.entries(binding.uniforms).map(([name, spec]) => [
      name,
      uniformBinding(binding.uniforms, name, spec.type),
    ]),
  );
  const origin = uniformBinding(uniforms, "renderOriginHigh", "vec3");
  const originLow = uniformBinding(uniforms, "renderOriginLow", "vec3");
  const tsl = binding.options.tsl;
  const fn = tsl
    ? null
    : N[language === "wgsl" ? "wgslFn" : "glslFn"](
        source(binding, stage, language),
      );
  return (record, originalRelative, seed) => {
    const scale = record.lnScales.exp().toVar();
    const rotation = record.quaternion;
    const color = record.rgba;
    if (tsl) {
      const parts = (relative) => {
        const local = relative.add(originLow).toVar();
        const high = origin.add(local.add(0.5).floor()).toVar();
        return [high, origin.sub(high).add(relative).add(originLow).toVar()];
      };
      const [high, low] = parts(record.center);
      const [originalCenterHigh, originalCenterLow] = parts(originalRelative);
      const world = high.add(low).toVar();
      const center = world.toVar();
      const centerHigh = high.toVar();
      const centerLow = low.toVar();
      tsl(
        {
          center,
          centerHigh,
          centerLow,
          scale,
          rotation,
          color,
          originalCenter: originalCenterHigh.add(originalCenterLow),
          originalCenterHigh,
          originalCenterLow,
          seed,
        },
        params,
      );
      const moved = centerHigh
        .notEqual(high)
        .select(
          centerHigh.sub(origin).add(centerLow.sub(originLow)),
          record.center.add(centerLow.sub(low)),
        );
      record.center.assign(moved.add(center.sub(world)));
    } else {
      const result = fn(
        record.center,
        scale,
        rotation,
        color,
        originalRelative,
        seed,
        origin,
        originLow,
        ...Object.values(params),
      ).toVar();
      record.center.assign(result.element(0).xyz);
      scale.assign(result.element(1).xyz);
      rotation.assign(result.element(2));
      color.assign(result.element(3));
    }
    record.lnScales.assign(scale.max(0).log());
  };
}
