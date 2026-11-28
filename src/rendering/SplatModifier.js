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
  "seed",
];

/** A binding belongs to one mesh or renderer. Shader text is immutable. */
export class SplatModifier {
  constructor(options, onChange) {
    this.options = { ...options };
    this.uniforms = Object.create(null);
    this.resources = new Map();
    this.version = 0;
    this.onChange = onChange;
    for (const [name, spec] of Object.entries(options.uniforms ?? {})) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ||
        fields.includes(name) ||
        /^(gl_|gsl)/i.test(name) ||
        !Object.hasOwn(wgslTypes, spec.type)
      ) {
        throw new Error(`Invalid splat modifier uniform: ${name}`);
      }
      this.uniforms[name] = { type: spec.type, value: spec.value };
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
        : /\b(originalCenter|seed)\b/.test(this.options.glsl ?? ""))
    );
  }
  setUniform(name, value) {
    if (!Object.hasOwn(this.uniforms, name))
      throw new Error(`Unknown splat modifier uniform: ${name}`);
    const uniform = this.uniforms[name];
    if (typeof value !== "object" && uniform.value === value) return;
    uniform.value = value;
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
  if (language === "glsl") {
    return `mat4 ${name}(vec3 center, vec3 scale, vec4 rotation, vec4 color, vec3 originalCenter, uint seed${params.map(([n, s]) => `, ${s.type} ${n}`).join("")}) {
      ${body}
      return mat4(vec4(center, 0.), vec4(scale, 0.), rotation, color);
    }`;
  }
  return `fn ${name}(gslCenter: vec3f, gslScale: vec3f, gslRotation: vec4f, gslColor: vec4f, originalCenter: vec3f, seed: u32${params.map(([n, v]) => `, ${n}: ${wgslTypes[v.type]}`).join("")}) -> mat4x4f {
    var center = gslCenter; var scale = gslScale; var rotation = gslRotation; var color = gslColor;
    ${body}
    return mat4x4f(vec4f(center, 0), vec4f(scale, 0), rotation, color);
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
    uniform vec3 renderOrigin;
    ${params.map(([n, s]) => `uniform ${s.type} gslParam_${n};`).join("\n")}
    ${source(binding, stage, "glsl")}
    #define GSL_APPLY(c,s,r,col,orig,id) gsl${stage}Modifier(c,s,r,col,orig,id${params.map(([n]) => `,gslParam_${n}`).join("")})
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
  const origin = uniformBinding(uniforms, "renderOrigin", "vec3");
  const tsl = binding.options.tsl;
  const fn = tsl
    ? null
    : N[language === "wgsl" ? "wgslFn" : "glslFn"](
        source(binding, stage, language),
      );
  return (record, originalCenter, seed) => {
    const world = record.center.add(origin).toVar();
    const center = world.toVar();
    const scale = record.lnScales.exp().toVar();
    const rotation = record.quaternion;
    const color = record.rgba;
    if (tsl) {
      tsl({ center, scale, rotation, color, originalCenter, seed }, params);
    } else {
      const result = fn(
        center,
        scale,
        rotation,
        color,
        originalCenter,
        seed,
        ...Object.values(params),
      ).toVar();
      center.assign(result.element(0).xyz);
      scale.assign(result.element(1).xyz);
      rotation.assign(result.element(2));
      color.assign(result.element(3));
    }
    // Apply only the world-space change. An identity hook preserves the precise center.
    record.center.addAssign(center.sub(world));
    record.lnScales.assign(scale.max(0).log());
  };
}
