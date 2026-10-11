// The denoiser uses a small, explicitly typed subset of WGSL. Translate that
// subset, so both shader languages keep the same weights and arithmetic.
const types = {
  f32: "float",
  i32: "int",
  u32: "uint",
  vec2f: "vec2",
  vec3f: "vec3",
  vec4f: "vec4",
  vec4u: "uvec4",
  vec2i: "ivec2",
  mat4x4f: "mat4",
  texture_depth_2d: "sampler2D",
};

const sampling = /* glsl */ `
vec4 ndLoad(sampler2D image, ivec2 p, int level) {
  return texelFetch(image, ivec2(p.x, textureSize(image, level).y - 1 - p.y), level);
}
vec4 ndSample(sampler2D image, vec2 uv, float level) {
  return textureLod(image, vec2(uv.x, 1.0 - uv.y), level);
}
float ndSelect(float a, float b, bool condition) { return condition ? b : a; }
vec3 ndSelect(vec3 a, vec3 b, bool condition) { return condition ? b : a; }
vec3 ndSelect(vec3 a, vec3 b, bvec3 condition) { return mix(a, b, condition); }
`;

/** GLSL functions, inputs and outputs of one denoiser fragment pass. */
export function neuralDenoiseGLSL(wgsl) {
  let code = wgsl.replace(/\/\/[^\n]*/g, "");
  code = code.replace(/@vertex fn vertex\([\s\S]*?\n}/, "");
  const textures = [];
  code = code.replace(
    /@group\(0\) @binding\(\d+\) var (\w+): (texture_2d<f32>|texture_depth_2d);/g,
    (_, name, type) => {
      textures.push({ name, depth: type === "texture_depth_2d" });
      return "";
    },
  );
  code = code.replace(
    /@group\(0\) @binding\(\d+\) var linearSampler: sampler;/g,
    "",
  );
  const params = code.includes("var<uniform> P:");
  code = code.replace(
    /@group\(0\) @binding\(0\) var<uniform> P: Params;/,
    "Params P;",
  );
  const output = code.match(/struct Output \{([\s\S]*?)\}/)?.[1];
  const members = output
    ? Array.from(
        output.matchAll(/@location\(\d+\) (\w+):/g),
        (match) => match[1],
      )
    : [];
  const depth = code.includes("@builtin(frag_depth)");
  code = code.replace(
    /@fragment fn fragment\((?:@builtin\(position\) position: vec4f)?\) -> (?:@location\(0\) |@builtin\(frag_depth\) )?(\w+)/,
    (_, type) => `fn ndFragment(position: vec4f) -> ${type}`,
  );
  code = code.replace(/@location\(\d+\) /g, "");
  // WGSL initializes locals to zero; the first frame reads this empty span.
  code = code.replace(
    "var previous: Resampled;",
    "var previous: Resampled = Resampled(vec4f(0.0), vec4f(0.0));",
  );
  code = code.replace(/texture_2d<f32>/g, "sampler2D");
  code = code.replace(/bitcast<vec4u>\(/g, "floatBitsToUint(");
  code = code.replace(/bitcast<vec4f>\(/g, "uintBitsToFloat(");
  code = code.replace(
    /\b(?:f32|i32|u32|vec[234]f|vec2i|vec4u|mat4x4f|texture_depth_2d)\b/g,
    (type) => types[type],
  );
  code = code.replace(/array<([\w]+),\s*(\d+)>/g, "$1[$2]");
  // Struct fields and function parameters have their type before their name.
  code = code.replace(
    /struct (\w+) \{([\s\S]*?)\};?/g,
    (_, name, fields) =>
      `struct ${name} {${fields.replace(/(\w+): (\w+)(\[\d+\])?,?/g, (_, field, type, count = "") => `${type} ${field}${count};`)}};`,
  );
  code = code.replace(
    /fn (\w+)\(([^)]*)\) -> (\w+)/g,
    (_, name, args, type) =>
      `${type} ${name}(${args.replace(/(\w+): (\w+)/g, "$2 $1")})`,
  );
  code = code.replace(
    /\b(let|var) (\w+): (\w+)(\[\d+\])?/g,
    (_, kind, name, type, count = "") => `${type} ${name}${count}`,
  );
  code = code.replace(
    /const (\w+) = (\w+)(\[\d+\])?\(/g,
    (_, name, type, count = "") =>
      `const ${type} ${name}${count} = ${type}${count}(`,
  );
  code = code.replace(/const (\w+) = ([\d.e+-]+);/g, "const float $1 = $2;");
  code = code.replace(/textureDimensions\((\w+)\)/g, "textureSize($1, 0)");
  code = code.replace(
    /textureSampleLevel\((\w+), linearSampler,/g,
    "ndSample($1,",
  );
  code = code.replace(/textureLoad\(/g, "ndLoad(");
  // Depth loads are scalar in WGSL, RGBA reads in GLSL.
  code = code.replace(
    /return ndLoad\(depthTexture, p, 0\);/,
    "return ndLoad(depthTexture, p, 0).r;",
  );
  code = code.replace(/\bselect\(/g, "ndSelect(");
  code = code.replace(
    /all\(h.uv >= vec2\(0.0\)\)/g,
    "all(greaterThanEqual(h.uv, vec2(0.0)))",
  );
  code = code.replace(
    /all\(h.uv <= vec2\(1.0\)\)/g,
    "all(lessThanEqual(h.uv, vec2(1.0)))",
  );
  code = code.replace(
    /x <= vec3\(0.0031308\)/g,
    "lessThanEqual(x, vec3(0.0031308))",
  );
  // GLSL reserves these identifiers.
  code = code
    .replace(/\bout\b/g, "ndResult")
    .replace(/\bshort\b/g, "shortHistory");
  // Classic WebGLRenderer uses log2(distance + 1), unlike node renderers.
  code = code.replace(
    "if (P.logDepth > 0.5) { return P.logNear * exp2(d * P.logFar); }",
    "if (P.logDepth > 1.5) { return exp2(d * P.logFar) - 1.0; }\n  if (P.logDepth > 0.5) { return P.logNear * exp2(d * P.logFar); }",
  );
  code = code.replace(
    "exp2(-d * P.logFar) / P.logNear",
    "(P.logDepth > 1.5 ? 1.0 / (exp2(d * P.logFar) - 1.0) : exp2(-d * P.logFar) / P.logNear)",
  );
  // WGSL permits a function to be defined after its caller; GLSL needs a prototype.
  const prototypes = Array.from(
    code.matchAll(/^(\w+ \w+\([^{}]*?\)) \{/gm),
    (m) => `${m[1]};`,
  ).join("\n");
  const structs = [];
  code = code.replace(/struct \w+ \{[\s\S]*?\};/g, (s) => {
    structs.push(s);
    return "";
  });
  return {
    code: `${sampling}\n${structs.join("\n")}\n${prototypes}\n${code}`,
    textures,
    params,
    members,
    depth,
  };
}
