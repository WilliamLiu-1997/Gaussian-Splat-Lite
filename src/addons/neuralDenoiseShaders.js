/** Floats in the uniform block shared by every pass; see PARAMS below. */
export const NEURAL_DENOISE_UNIFORM_FLOATS = 68;
const float = (value) => {
  const text = value.toPrecision(9);
  return /[.e]/.test(text) ? text : `${text}.0`;
};
const vec4 = (values) => `vec4f(${values.map(float).join(", ")})`;
const range = (count) => Array.from({ length: count }, (_, i) => i);
// Channels travel in groups of four, one vec4 or one render target each.
/** A pointwise layer: a mat4x4 per output and input group, NAME_<o>_<i>, and a bias NAME_b<o>. */
function pointwise(name, { w, b }) {
  const inputs = w.length / b.length;
  const lines = [];
  for (const o of range(b.length / 4)) {
    for (const i of range(inputs / 4)) {
      const columns = range(4).map((column) =>
        vec4(range(4).map((row) => w[(4 * o + row) * inputs + 4 * i + column])),
      );
      lines.push(`const ${name}_${o}_${i} = mat4x4f(${columns.join(", ")});`);
    }
    lines.push(`const ${name}_b${o} = ${vec4(b.slice(4 * o, 4 * o + 4))};`);
  }
  return lines.join("\n");
}
/** What a pointwise layer sums for one group of outputs. */
const mixed = (name, group, inputs) =>
  `${inputs.map((x, i) => `${name}_${group}_${i} * ${x}`).join(" + ")} + ${name}_b${group}`;
// Correct the block's decisions with this pixel's current frame and history.
// The network adds no state, textures or passes; a zero head preserves them.
function pixelCorrection(correction) {
  if (!correction) return "";
  return /* wgsl */ `
${pointwise("PIXEL_ENCODE", correction.hidden)}
${pointwise("PIXEL_HEAD", correction.out)}
fn correctedPixels(color: vec4f, d: vec4f, sr: vec4f, dr: vec4f,
    aux: vec4f, trust: vec4f, strength: f32) -> vec4f {
  let ys: f32 = luma(sr.rgb);
  let yd: f32 = luma(d.rgb);
  let deviation: f32 = sqrt(max(aux.x - ys * ys, 0.0) + 1e-8);
  let scale: f32 = deviation + 0.02;
  let stats: vec4f = vec4f(
    min(abs(luma(color.rgb) - ys) / scale, 4.0),
    min(abs(yd - luma(dr.rgb)) / scale, 4.0),
    min(abs(aux.w - yd) / scale, 4.0), min(deviation, 1.0));
  let colors: vec4f = min(abs(vec4f(chroma(color.rgb) - chroma(sr.rgb),
    chroma(d.rgb) - chroma(dr.rgb))) / scale, vec4f(4.0));
  let probabilities: vec4f = vec4f(trust.xy, trust.w, strength);
  let hidden: vec4f = silu(${mixed("PIXEL_ENCODE", 0, ["stats", "colors", "probabilities"])});
  let ratio: vec4f = exp(${mixed("PIXEL_HEAD", 0, ["hidden"])});
  return probabilities * ratio / (vec4f(1.0) - probabilities + probabilities * ratio);
}`;
}
/** A depthwise 3x3 layer: nine tap weights NAME_<group> and a bias NAME_b<group>. */
function depthwise(name, { w, b }) {
  return range(b.length / 4)
    .map((group) => {
      const taps = range(9).map((tap) =>
        vec4(range(4).map((channel) => w[(4 * group + channel) * 9 + tap])),
      );
      return `const ${name}_${group} = array<vec4f, 9>(${taps.join(", ")});
const ${name}_b${group} = ${vec4(b.slice(4 * group, 4 * group + 4))};`;
    })
    .join("\n");
}
/** One output of the head: a vec4 per input group, NAME_<i>, and a bias NAME_b. */
function head(name, { w, b }, output) {
  const inputs = w.length / b.length;
  return `${range(inputs / 4)
    .map(
      (i) =>
        `const ${name}_${i} = ${vec4(w.slice(output * inputs + 4 * i, output * inputs + 4 * i + 4))};`,
    )
    .join("\n")}
const ${name}_b = ${float(b[output])};`;
}
/** What the head sums for one output. */
const headed = (name, inputs) =>
  `${inputs.map((x, i) => `dot(${name}_${i}, ${x})`).join(" + ")} + ${name}_b`;
/** A pointwise layer with `count` more inputs before input `at`, which it ignores. */
const widened = ({ w, b }, at, count) => {
  const inputs = w.length / b.length;
  return {
    w: b.flatMap((_, o) => [
      ...w.slice(o * inputs, o * inputs + at),
      ...Array(count).fill(0),
      ...w.slice(o * inputs + at, (o + 1) * inputs),
    ]),
    b,
  };
};
/**
 * Reads a layer's input textures through a 3x3 depthwise layer into a0, a1, ...
 * and applies SiLU. `bounded` names the function that keeps a tap inside the
 * layer's image.
 */
const depthwiseTaps = (name, groups, bounded) => /* wgsl */ `
${groups.map((g) => `  var a${g}: vec4f = ${name}_b${g};`).join("\n")}
${range(9)
  .map(
    (tap) => `  {
    let q: vec2i = ${bounded}(p + TAPS[${tap}]);
${groups.map((g) => `    a${g} += ${name}_${g}[${tap}] * textureLoad(input${g}, q, 0);`).join("\n")}
  }`,
  )
  .join("\n")}
${groups.map((g) => `  a${g} = silu(a${g});`).join("\n")}`;
const VERTEX = /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let xy: vec2f = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}`;
const MATH = /* wgsl */ `
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.25, 0.5, 0.25)); }
fn chroma(c: vec3f) -> vec2f {
  return vec2f(0.5 * (c.r - c.b), -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn silu(x: vec4f) -> vec4f { return x / (1.0 + exp(-x)); }
fn sigmoid(x: f32) -> f32 { return 1.0 / (1.0 + exp(-x)); }`;
const PARAMS = /* wgsl */ `
struct Params {
  toPrevClip: mat4x4f, // current view to previous unjittered clip
  toClip: mat4x4f,     // current view to current unjittered clip
  toPrevViewZ: vec4f,  // current view to previous view z
  unprojectA: vec4f,   // p00, p11, p02, p12 of the jittered projection
  unprojectB: vec4f,   // p03, p13, p32, p33
  depth: vec4f,        // p22, p32, p23, p33
  size: vec2f,
  invSize: vec2f,
  far: f32,
  clearDepth: f32,
  historyValid: f32,
  stabilize: f32,
  halfBias: f32,
  logDepth: f32,
  logNear: f32,
  logFar: f32,
  turn: f32,           // angle between the previous and this frame's camera orientation
  cameraStill: f32,    // unchanged view and projection; history stays on the same pixel
  offset: vec2f,       // where in its target the scene was drawn
  colorOffset: vec2f,  // zero after encoding, otherwise the scene's offset
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var linearSampler: sampler;
${VERTEX}
${MATH}
fn bounded(p: vec2i) -> vec2i { return clamp(p, vec2i(0), vec2i(P.size) - 1); }
// The scene's target has a margin, and the scene is drawn at an offset in it
// (see the node): the texel that holds pixel p.
fn drawn(p: vec2i) -> vec2i { return bounded(p) + vec2i(P.offset); }
// Read the capture directly unless colour conversion made a cropped copy.
// Filtered taps clamp to the drawn viewport, excluding the target's margin.
fn frameLoad(image: texture_2d<f32>, p: vec2i) -> vec4f {
  return textureLoad(image, p + vec2i(P.colorOffset), 0);
}
fn frameSample(image: texture_2d<f32>, p: vec2f) -> vec4f {
  let uv: vec2f = (clamp(p, vec2f(0.5), P.size - 0.5) + P.colorOffset) / vec2f(textureDimensions(image));
  return textureSampleLevel(image, linearSampler, uv, 0.0);
}

// Some GPUs truncate a float written to a half-float target instead of
// rounding it. A running mean over 128 frames then loses half a unit in the
// last place on every write and drifts several percent too dark. Adding the
// measured bias (half a unit where the GPU truncates, nothing where it
// rounds) makes every write round to nearest.
fn roundedHalf(v: vec4f) -> vec4f {
  let magnitude: vec4f = max(abs(v), vec4f(6.1035156e-5));
  // The exponent bits give 2^floor(log2(magnitude)) without transcendental math.
  let exponent: vec4f = bitcast<vec4f>(bitcast<vec4u>(magnitude) & vec4u(0x7f800000u));
  return v + sign(v) * P.halfBias * (exponent / 1024.0);
}

struct History {
  uv: vec2f,
  valid: f32,
  motion: f32,
  previousZ: f32,
};

// Where the surface seen at this pixel was in the previous frame, from the
// camera alone. Moving objects are not followed.
fn reproject(pixel: vec2f, z: f32) -> History {
  let uv: vec2f = pixel * P.invSize;
  let zv: f32 = -z;
  let cw: f32 = P.unprojectB.z * zv + P.unprojectB.w;
  let x: f32 = ((2.0 * uv.x - 1.0) * cw - P.unprojectA.z * zv - P.unprojectB.x) / P.unprojectA.x;
  let y: f32 = ((1.0 - 2.0 * uv.y) * cw - P.unprojectA.w * zv - P.unprojectB.y) / P.unprojectA.y;
  let position: vec4f = vec4f(x, y, zv, 1.0);
  let previous: vec4f = P.toPrevClip * position;
  let current: vec4f = P.toClip * position;
  var w: f32 = previous.w;
  if (abs(w) < 1e-8) { w = 1e-8; }
  let motion: vec2f = current.xy / current.w - previous.xy / w;
  var h: History;
  h.uv = uv + vec2f(-0.5, 0.5) * motion;
  h.valid = f32(previous.w > 0.0 && all(h.uv >= vec2f(0.0)) && all(h.uv <= vec2f(1.0)));
  h.motion = length(0.5 * P.size * motion);
  h.previousZ = -dot(P.toPrevViewZ, position);
  return h;
}

// Catmull-Rom from five bilinear taps: the four corner taps of the nine-tap
// form are dropped and the rest renormalised. On the trained model the two
// differ by less than 0.05 dB. The span is what the five taps span, per channel.
struct Resampled {
  value: vec4f,
  span: vec4f,
};
fn catmullRomSpan(image: texture_2d<f32>, uv: vec2f) -> Resampled {
  let position: vec2f = uv * P.size;
  let center: vec2f = floor(position - 0.5) + 0.5;
  let t: vec2f = position - center;
  let w0: vec2f = t * (-0.5 + t * (1.0 - 0.5 * t));
  let w1: vec2f = 1.0 + t * t * (-2.5 + 1.5 * t);
  let w2: vec2f = t * (0.5 + t * (2.0 - 1.5 * t));
  let w3: vec2f = t * t * (-0.5 + 0.5 * t);
  let w12: vec2f = w1 + w2;
  let p0: vec2f = (center - 1.0) * P.invSize;
  let p12: vec2f = (center + w2 / w12) * P.invSize;
  let p3: vec2f = (center + 2.0) * P.invSize;
  let middle: vec4f = textureSampleLevel(image, linearSampler, vec2f(p12.x, p12.y), 0.0);
  let left: vec4f = textureSampleLevel(image, linearSampler, vec2f(p0.x, p12.y), 0.0);
  let right: vec4f = textureSampleLevel(image, linearSampler, vec2f(p3.x, p12.y), 0.0);
  let above: vec4f = textureSampleLevel(image, linearSampler, vec2f(p12.x, p0.y), 0.0);
  let below: vec4f = textureSampleLevel(image, linearSampler, vec2f(p12.x, p3.y), 0.0);
  var result: vec4f = middle * (w12.x * w12.y);
  result += left * (w0.x * w12.y);
  result += right * (w3.x * w12.y);
  result += above * (w12.x * w0.y);
  result += below * (w12.x * w3.y);
  var out: Resampled;
  out.value = result / (w12.x * w12.y + (w0.x + w3.x) * w12.y + w12.x * (w0.y + w3.y));
  out.span = max(max(max(middle, left), max(right, above)), below) -
    min(min(min(middle, left), min(right, above)), below);
  return out;
}
fn catmullRom(image: texture_2d<f32>, uv: vec2f) -> vec4f {
  return catmullRomSpan(image, uv).value;
}

// Lanczos-3 without its corner taps, from nine bilinear taps: the middle pair
// of each axis is one tap and the other four pixels of an axis one each. A
// history that is resampled once per frame loses fine detail with every pass,
// and this kernel loses about half of what Catmull-Rom does. Its negative
// lobes would ring over such a history, so the result is kept inside what the
// four pixels around the position span. At a pixel's centre it returns the
// pixel.
struct LanczosWeights {
  low: vec3f,
  high: vec3f,
};
fn lanczosWeights(t: f32) -> LanczosWeights {
  // Integer-shifted sinc taps share their sine. Angle addition supplies the
  // other factor, reducing twelve sine evaluations per axis to three trig calls.
  let x: f32 = 3.14159265 * t;
  let s: f32 = sin(x / 3.0);
  let c: f32 = 0.866025404 * cos(x / 3.0);
  let scale: f32 = 0.303963551 * sin(x);
  let terms: vec3f = scale * vec3f(c - 0.5 * s, -c - 0.5 * s, s);
  let low: vec3f = vec3f(t + 2.0, t + 1.0, t);
  let high: vec3f = vec3f(t - 1.0, t - 2.0, t - 3.0);
  var w: LanczosWeights;
  w.low = terms / max(low * low, vec3f(1e-20));
  w.high = terms / max(high * high, vec3f(1e-20));
  if (abs(x) < 1e-5) { w.low.z = 1.0; }
  if (abs(3.14159265 * (t - 1.0)) < 1e-5) { w.high.x = 1.0; }
  return w;
}
struct LanczosKernel {
  base: vec2f,
  centre: vec2f,
  middle: f32,
  wx: vec4f,
  wy: vec4f,
  total: f32,
}
fn lanczosKernel(uv: vec2f) -> LanczosKernel {
  let position: vec2f = uv * P.size - 0.5;
  var k: LanczosKernel;
  k.base = floor(position);
  let t: vec2f = position - k.base;
  let x: LanczosWeights = lanczosWeights(t.x);
  let y: LanczosWeights = lanczosWeights(t.y);
  let middle: vec2f = vec2f(x.low.z + x.high.x, y.low.z + y.high.x);
  k.centre = (k.base + vec2f(x.high.x, y.high.x) / middle + 0.5) * P.invSize;
  // All three histories share these 2D tap weights and their normalization.
  k.middle = middle.x * middle.y;
  k.wx = vec4f(x.low.xy, x.high.yz) * middle.y;
  k.wy = vec4f(y.low.xy, y.high.yz) * middle.x;
  k.total = k.middle;
  for (var i: i32 = 0; i < 4; i++) { k.total += k.wx[i] + k.wy[i]; }
  return k;
}
fn lanczosCross(image: texture_2d<f32>, k: LanczosKernel) -> vec4f {
  var sum: vec4f = textureSampleLevel(image, linearSampler, k.centre, 0.0) * k.middle;
  const offsets = array<f32, 4>(-1.5, -0.5, 2.5, 3.5);
  for (var i: i32 = 0; i < 4; i++) {
    let along: vec2f = (k.base + offsets[i]) * P.invSize;
    sum += textureSampleLevel(image, linearSampler, vec2f(along.x, k.centre.y), 0.0) * k.wx[i];
    sum += textureSampleLevel(image, linearSampler, vec2f(k.centre.x, along.y), 0.0) * k.wy[i];
  }
  let p: vec2i = vec2i(k.base);
  let a: vec4f = textureLoad(image, bounded(p), 0);
  let b: vec4f = textureLoad(image, bounded(p + vec2i(1, 0)), 0);
  let c: vec4f = textureLoad(image, bounded(p + vec2i(0, 1)), 0);
  let d: vec4f = textureLoad(image, bounded(p + vec2i(1, 1)), 0);
  return clamp(sum / k.total, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}
`;
const TAPS = /* wgsl */ `
const TAPS = array<vec2i, 9>(
  vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1),
  vec2i(-1, 0), vec2i(0, 0), vec2i(1, 0),
  vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1));
`;
const sceneDepth = (multisampled) => /* wgsl */ `
@group(0) @binding(2) var depthTexture: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
fn sceneDepth(p: vec2i) -> f32 {
  // Sample 0 for MSAA, mip 0 otherwise. One coverage decision preserves a
  // faint foreground's hit probability; nearest-of-four overrepresents it.
  return textureLoad(depthTexture, p, 0);
}
fn viewDepth(d: f32) -> f32 {
  if (P.logDepth > 0.5) { return P.logNear * exp2(d * P.logFar); }
  return -(P.depth.z - d * P.depth.w) / (d * P.depth.y - P.depth.x);
}`;
// What was drawn in each cell of 8x8 pixels: the sum of its pixels'
// disparities, how many were drawn, and the sum of the disparities' squares.
// A block with no depth of its own takes one from these (see the depth pass).
//
// The loop holds no branch: with one on whether a pixel was drawn, this pass
// took 1 ms at 2560x1600 on an Apple M5 Pro where it takes 0.1 ms without.
const cellSums = (disparity) => /* wgsl */ `
  for (var y: i32 = 0; y < 8; y++) {
    for (var x: i32 = 0; x < 8; x++) {
      let d: f32 = sceneDepth(drawn(corner + vec2i(x, y)));
      // One over viewDepth(d).
      let disparity: f32 = ${disparity};
      sums += select(vec3f(0.0), vec3f(disparity, 1.0, disparity * disparity), d != P.clearDepth);
    }
  }
`;
const cells = (multisampled) => /* wgsl */ `${PARAMS}${sceneDepth(multisampled)}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let corner: vec2i = vec2i(position.xy) * 8;
  var sums: vec3f = vec3f(0.0);
  // One uniform branch, outside the pixel loop, skips unused depth math.
  if (P.logDepth > 0.5) {
${cellSums("exp2(-d * P.logFar) / P.logNear")}
  } else {
${cellSums("(d * P.depth.y - P.depth.x) / (d * P.depth.w - P.depth.z)")}
  }
  return vec4f(sums, 1.0);
}`;
// The same sums over cells four times as wide: 4x4 cells of the level below.
// A level narrower than one cell is one cell, its border repeated.
const WIDER = /* wgsl */ `${VERTEX}
@group(0) @binding(1) var cells: texture_2d<f32>;
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let corner: vec2i = vec2i(position.xy) * 4;
  let last: vec2i = vec2i(textureDimensions(cells)) - 1;
  var sums: vec3f = vec3f(0.0);
  for (var y: i32 = 0; y < 4; y++) {
    for (var x: i32 = 0; x < 4; x++) {
      sums += textureLoad(cells, min(corner + vec2i(x, y), last), 0).rgb;
    }
  }
  return vec4f(sums, 1.0);
}`;
// The view depth reprojection uses: one value per 2x2 block, taken around the
// block's top-left pixel, and beside it whether the block had none of its own.
const depth = (
  weights,
  multisampled,
) => /* wgsl */ `${PARAMS}${TAPS}${sceneDepth(multisampled)}
@group(0) @binding(3) var cells8: texture_2d<f32>;
@group(0) @binding(4) var cells32: texture_2d<f32>;
@group(0) @binding(5) var cells128: texture_2d<f32>;
@group(0) @binding(6) var cells512: texture_2d<f32>;
@group(0) @binding(7) var colorTexture: texture_2d<f32>;
// What a cell lends a block with no depth of its own, and whether it had
// enough pixels drawn to decide (y). It lends the mean of their disparities
// where they agree on a depth and the far plane where they do not: lent a
// mean of two depths, a thin pole before distant trees read its history
// beside itself.
fn lending(cells: texture_2d<f32>, p: vec2i, width: i32) -> vec2f {
  let sums: vec3f = textureLoad(cells, min(p / width, vec2i(textureDimensions(cells)) - 1), 0).rgb;
  if (sums.y < ${float(weights.lendLeast)}) { return vec2f(P.far, 0.0); }
  let agree: bool = sums.z * sums.y - sums.x * sums.x < ${float(weights.lendSpread * weights.lendSpread)} * sums.x * sums.x;
  return vec2f(select(P.far, sums.y / sums.x, agree), 1.0);
}
// Stochastic depth is whichever layer survived at each pixel, so it jumps
// between layers from frame to frame. The third nearest of the neighbourhood,
// with empty pixels at far, ignores a faint layer in front that one or two
// pixels hit, yet keeps a one-pixel line or a foreground edge.
//
// Where fewer than three were drawn the block has no depth of its own, and
// read at the far plane its history moves with the empty background: the soft
// rim of a thin branch then slid away from the branch, and its light was
// carried into the background and stayed. Such a block takes the depth of
// what was drawn around it, from the narrowest cell that had enough drawn, so
// that a rim moves with its branch and the empty space beside a model with
// the model.
fn blockViewDepth(p: vec2i) -> vec4f {
  // View depth is monotonic: rank the raw samples first, then unproject only
  // the third nearest. Negating reversed depth keeps the same ordering.
  let direction: f32 = select(1.0, -1.0, P.clearDepth == 0.0 && P.logDepth < 0.5);
  var nearest: vec3f = vec3f(3.0e38);
  for (var j: i32 = 0; j < 9; j++) {
    let d: f32 = sceneDepth(drawn(p + TAPS[j]));
    let z: f32 = select(d * direction, 3.0e38, d == P.clearDepth);
    let a: f32 = max(nearest.x, z);
    let b: f32 = max(nearest.y, a);
    nearest = vec3f(min(nearest.x, z), min(nearest.y, a), min(nearest.z, b));
  }
  if (nearest.z < 3.0e38) {
    let z: f32 = viewDepth(nearest.z * direction);
    if (z < P.far) { return vec4f(z, 0.0, 0.0, 1.0); }
  }
  var lent: vec2f = lending(cells8, p, 8);
  if (lent.y == 0.0) { lent = lending(cells32, p, 32); }
  if (lent.y == 0.0) { lent = lending(cells128, p, 128); }
  if (lent.y == 0.0) { lent = lending(cells512, p, 512); }
  return vec4f(lent.x, 1.0, 0.0, 1.0);
}
struct Output {
  @location(0) depth: vec4f,
  @location(1) color: vec4f,
};
// Both outputs have one texel per 2x2 block of the captured image.
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  var out: Output;
  out.depth = blockViewDepth(vec2i(position.xy) * 2);
  out.color = frameSample(colorTexture, position.xy * 2.0);
  return out;
}`;
// The scene's depth without the target's margin, for the application.
const expose = (
  multisampled,
) => /* wgsl */ `${PARAMS}${sceneDepth(multisampled)}
@fragment fn fragment(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  return sceneDepth(drawn(vec2i(position.xy)));
}`;
// A linear working colour space needs a display-referred copy for the
// network; the output node decodes its result. Otherwise read the scene
// directly, including the resolved colour of a multisampled capture.
const ENCODE = /* wgsl */ `${PARAMS}
@group(0) @binding(2) var image: texture_2d<f32>;
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c: vec4f = textureLoad(image, drawn(vec2i(position.xy)), 0);
  // Premultiplied: the transfer applies to the colour itself.
  let alpha: f32 = max(c.a, 1e-6);
  let x: vec3f = max(c.rgb / alpha, vec3f(0.0));
  let encoded: vec3f = select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
  return vec4f(encoded * alpha, c.a);
}`;
// Halves an image: each pixel is the mean of 2x2, one bilinear tap at the
// corner the four share. An odd last row or column is left out, so a pixel of
// any level covers whole pixels of the frame, counted from its top-left
// corner; COARSE below reads such a level.
const DOWNSAMPLE = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureSampleLevel(image, linearSampler, position.xy * 2.0 / vec2f(textureDimensions(image)), 0.0);
}`;
const COARSE = /* wgsl */ `
// Bilinear lookup, at a position in pixels of the frame, in an image whose
// pixels each stand for \`pixels\` x \`pixels\` of them.
fn coarse(image: texture_2d<f32>, position: vec2f, pixels: f32) -> vec4f {
  return textureSampleLevel(image, linearSampler, position / (pixels * vec2f(textureDimensions(image))), 0.0);
}`;
// Draws a value three quarters of the way between two halves; which one is
// stored tells how the GPU rounds.
const ROUNDING = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var<uniform> value: vec4f;
@fragment fn fragment() -> @location(0) vec4f { return value; }`;
/**
 * The passes of a learned spatial filter: a 3x3 kernel predicted for every
 * pixel, coarse to fine over the
 * frame's image pyramid and then at full resolution. Each level filters itself
 * and decides per pixel how much of that to keep over the level below; the
 * image is only ever averaged. It reads the frame alone, no history.
 *
 * Per level, coarsest first: `encode` (the level's colour, the result of the
 * level below, the noise at its scale and the hidden channels of the level
 * below, through a pointwise layer) and `kernel` (a depthwise and a pointwise
 * layer, then the head and the filtering itself). `top` does the head and the
 * filtering at full resolution from the half-resolution hidden channels.
 * `encode[0]` and `kernel[0]` are the half-resolution level.
 */
function learnedFilter(filter) {
  const groups = range(filter.levels[0].pointwise.b.length / 4);
  const hidden = groups.map((g) => `b${g}`);
  const targets = (name) =>
    groups.map((g) => `  @location(${g}) ${name}${g}: vec4f,`).join("\n");
  // The head's ten outputs from the hidden channels: nine kernel weights
  // through a softmax, and the share of the filtered image to keep.
  const constants = (layer) => {
    const inputs = layer.w.length / layer.b.length;
    return `${pointwise("KERNEL", { w: layer.w.slice(0, 8 * inputs), b: layer.b.slice(0, 8) })}
${head("LAST", layer, 8)}
${head("KEEP", layer, 9)}`;
  };
  const filtering = (image, bounded) => /* wgsl */ `
  let k0: vec4f = ${mixed("KERNEL", 0, hidden)};
  let k1: vec4f = ${mixed("KERNEL", 1, hidden)};
  let k2: f32 = ${headed("LAST", hidden)};
  let peak: f32 = max(max(max(k0.x, k0.y), max(k0.z, k0.w)), max(max(max(k1.x, k1.y), max(k1.z, k1.w)), k2));
  let e0: vec4f = exp(k0 - peak);
  let e1: vec4f = exp(k1 - peak);
  let e2: f32 = exp(k2 - peak);
  let taps: array<f32, 9> = array<f32, 9>(e0.x, e0.y, e0.z, e0.w, e1.x, e1.y, e1.z, e1.w, e2);
  var sum: vec4f = vec4f(0.0);
  for (var j: i32 = 0; j < 9; j++) {
    sum += taps[j] * ${image === "colorTexture" ? `frameLoad(${image}, ${bounded}(p + TAPS[j]))` : `textureLoad(${image}, ${bounded}(p + TAPS[j]), 0)`};
  }
  let smoothed: vec4f = sum / (dot(e0 + e1, vec4f(1.0)) + e2);
  let keep: f32 = sigmoid(${headed("KEEP", hidden)});`;
  const levels = filter.levels.map((layers, n) => {
    const last = n === filter.levels.length - 1;
    const below = last ? [] : groups.map((g) => `x${2 + g}`);
    const encode = /* wgsl */ `${PARAMS}
${pointwise("ENCODE", widened(layers.encode, 7, 1))}
${COARSE}
${last ? "" : "@group(0) @binding(2) var level: texture_2d<f32>;"}
@group(0) @binding(${last ? 2 : 3}) var finer: texture_2d<f32>;
${
  last
    ? ""
    : `@group(0) @binding(4) var below: texture_2d<f32>;
${groups.map((g) => `@group(0) @binding(${5 + g}) var hidden${g}: texture_2d<f32>;`).join("\n")}`
}
struct Output {
${targets("encoded")}
${last ? `  @location(${groups.length}) color: vec4f,` : ""}
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p: vec2i = vec2i(position.xy);
  let color: vec4f = ${last ? "textureSampleLevel(finer, linearSampler, position.xy * 2.0 / vec2f(textureDimensions(finer)), 0.0)" : "textureLoad(level, p, 0)"};
  let own: vec3f = color.rgb;
  // How far the four finer pixels this one stands for are from their mean:
  // the noise at this scale.
  var noise: f32 = 0.0;
  for (var j: i32 = 0; j < 4; j++) {
    noise += abs(luma(${n === 0 ? "frameLoad(finer, p * 2 + vec2i(j & 1, j >> 1))" : "textureLoad(finer, p * 2 + vec2i(j & 1, j >> 1), 0)"}.rgb) - luma(own));
  }
  let under: vec3f = ${last ? "own" : "coarse(below, position.xy, 2.0).rgb"};
  let x0: vec4f = vec4f(own, under.r);
  let x1: vec4f = vec4f(under.gb, 0.25 * noise, 0.0);
${last ? "" : groups.map((g) => `  let x${2 + g}: vec4f = coarse(hidden${g}, position.xy, 2.0);`).join("\n")}
  var out: Output;
${groups.map((g) => `  out.encoded${g} = silu(${mixed("ENCODE", g, ["x0", "x1", ...below])});`).join("\n")}
${last ? "  out.color = color;" : ""}
  return out;
}`;
    const kernel = /* wgsl */ `${VERTEX}${MATH}${TAPS}
${depthwise("DEPTHWISE", layers.depthwise)}
${pointwise("POINTWISE", layers.pointwise)}
${constants(layers.head)}
@group(0) @binding(0) var linearSampler: sampler;
${COARSE}
${groups.map((g) => `@group(0) @binding(${1 + g}) var input${g}: texture_2d<f32>;`).join("\n")}
@group(0) @binding(${1 + groups.length}) var level: texture_2d<f32>;
${last ? "" : `@group(0) @binding(${2 + groups.length}) var below: texture_2d<f32>;`}
struct Output {
${targets("hidden")}
  @location(${groups.length}) result: vec4f,
};
fn boundedLevel(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(textureDimensions(level)) - 1);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p: vec2i = vec2i(position.xy);
${depthwiseTaps("DEPTHWISE", groups, "boundedLevel")}
${groups
  .map(
    (g) =>
      `  let b${g}: vec4f = silu(${mixed(
        "POINTWISE",
        g,
        groups.map((i) => `a${i}`),
      )});`,
  )
  .join("\n")}
${filtering("level", "boundedLevel")}
  let under: vec4f = ${last ? "textureLoad(level, p, 0)" : "coarse(below, position.xy, 2.0)"};
  var out: Output;
${groups.map((g) => `  out.hidden${g} = b${g};`).join("\n")}
  out.result = mix(under, smoothed, keep);
  return out;
}`;
    return { encode, kernel };
  });
  // A robust filter's full-resolution kernel also sees how far its own pixel
  // is from the half-resolution result, as two inputs after the hidden
  // channels, and weights each tap down by how far that tap is from it, at a
  // rate it predicts: an eleventh output. The 2x2 pixels of a block share
  // their hidden channels, so without this the kernel cannot leave out the one
  // of them that holds a stray sample.
  const robust = filter.robust !== undefined;
  const topLayer = robust ? widened(filter.top, 10, 2) : filter.top;
  const seen = robust ? [...hidden, "away"] : hidden;
  const top = /* wgsl */ `${PARAMS}${TAPS}${COARSE}
${constants(topLayer)}
${robust ? head("RATE", topLayer, 10) : ""}
@group(0) @binding(2) var colorTexture: texture_2d<f32>;
${groups.map((g) => `@group(0) @binding(${3 + g}) var hidden${g}: texture_2d<f32>;`).join("\n")}
@group(0) @binding(${3 + groups.length}) var below: texture_2d<f32>;
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p: vec2i = vec2i(position.xy);
${groups.map((g) => `  let b${g}: vec4f = coarse(hidden${g}, position.xy, 2.0);`).join("\n")}
${
  robust
    ? `  let under: vec4f = coarse(below, position.xy, 2.0);
  let level: f32 = luma(under.rgb);
  let own: f32 = luma(frameLoad(colorTexture, p).rgb) - level;
  let away: vec4f = vec4f(own, abs(own), 0.0, 0.0);
  let k0: vec4f = ${mixed("KERNEL", 0, seen)};
  let k1: vec4f = ${mixed("KERNEL", 1, seen)};
  let k2: f32 = ${headed("LAST", seen)};
  let rate: f32 = ${float(filter.robust ?? 0)} * log(1.0 + exp(${headed("RATE", seen)}));
  var logits: array<f32, 9> = array<f32, 9>(k0.x, k0.y, k0.z, k0.w, k1.x, k1.y, k1.z, k1.w, k2);
  var texels: array<vec4f, 9>;
  var peak: f32 = -1e30;
  for (var j: i32 = 0; j < 9; j++) {
    texels[j] = frameLoad(colorTexture, bounded(p + TAPS[j]));
    logits[j] -= rate * abs(luma(texels[j].rgb) - level);
    peak = max(peak, logits[j]);
  }
  var sum: vec4f = vec4f(0.0);
  var total: f32 = 0.0;
  for (var j: i32 = 0; j < 9; j++) {
    let weight: f32 = exp(logits[j] - peak);
    sum += weight * texels[j];
    total += weight;
  }
  let keep: f32 = sigmoid(${headed("KEEP", seen)});
  return roundedHalf(mix(under, sum / total, keep));`
    : `${filtering("colorTexture", "bounded")}
  return roundedHalf(mix(coarse(below, position.xy, 2.0), smoothed, keep));`
}
}`;
  return {
    encode: levels.map((level) => level.encode),
    kernel: levels.map((level) => level.kernel),
    top,
    groups: groups.length,
  };
}
const COMPACT_FILTER = /* wgsl */ `
// Exact clamped 3x3 mean, using bilinear pairs on each axis.
fn compactFiltered(p: vec2f) -> vec4f {
  return (4.0 * frameSample(colorTexture, p - vec2f(0.5)) +
    2.0 * frameSample(colorTexture, p + vec2f(1.0, -0.5)) +
    2.0 * frameSample(colorTexture, p + vec2f(-0.5, 1.0)) +
    frameSample(colorTexture, p + vec2f(1.0))) / 9.0;
}
`;

/**
 * The WGSL of every pass, with the trained weights written in as constants.
 * Each fragment shader's bindings are: the uniform block, a linear sampler,
 * then its textures in the order they are declared.
 *
 * Both modes keep view depth per 2x2 block. The network runs on 4x4 blocks,
 * followed by per-pixel reprojection, filtering, blending and stabilization.
 * Performance uses fixed local filtering and simpler history sampling;
 * Quality uses learned multiscale filtering.
 */
export function neuralDenoiseShaders(weights, multisampled = false) {
  const net = weights.network;
  const learned = learnedFilter(weights.filter);
  const groups = range(net.encode.b.length / 4);
  const inputTextures = groups
    .map((g) => `@group(0) @binding(${2 + g}) var input${g}: texture_2d<f32>;`)
    .join("\n");
  const targets = (name) =>
    groups.map((g) => `  @location(${g}) ${name}${g}: vec4f,`).join("\n");
  const BOUNDED = /* wgsl */ `
// The network runs on 4x4 blocks, in an image of a quarter the size.
fn boundedBlock(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(floor(P.size * 0.25)) - 1);
}`;
  // A pass that uses these declares depthBlocks.
  const BLOCKS = /* wgsl */ `${BOUNDED}
// The view depth of the 2x2 block a pixel lies in.
fn blockDepth(pixel: vec2i) -> f32 {
  return textureLoad(depthBlocks, min(pixel / 2, vec2i(floor(P.size * 0.5)) - 1), 0).r;
}
// 1 where too little was drawn in that block for a depth of its own.
fn blockSparse(pixel: vec2i) -> f32 {
  return textureLoad(depthBlocks, min(pixel / 2, vec2i(floor(P.size * 0.5)) - 1), 0).g;
}`;
  const BLOCK_FILTERED = weights.compact
    ? /* wgsl */ `
fn blockFiltered(block: vec2i, color: vec4f) -> vec4f {
  let c: vec2f = vec2f(block * 4 + 2);
  var sum: vec4f = vec4f(0.0);
  for (var y: i32 = -1; y <= 1; y++) {
    for (var x: i32 = -1; x <= 1; x++) {
      let wx: f32 = select(0.25, 0.5, x == 0);
      let wy: f32 = select(0.25, 0.5, y == 0);
      sum += wx * wy * frameSample(colorTexture, c + vec2f(f32(x), f32(y)) * (11.0 / 6.0));
    }
  }
  return mix(color, sum, 0.5);
}
`
    : /* wgsl */ `
fn blockFiltered(block: vec2i, color: vec4f) -> vec4f {
  return blockMean(filteredTexture, vec2f(block * 4 + 2) * P.invSize);
}`;
  // The network's inputs and its first layer, per 4x4 block.
  const features = /* wgsl */ `${PARAMS}
${pointwise("ENCODE", net.encode)}
${[
  "depthBlocks",
  "depthPrevious",
  "colorTexture",
  "levelOne",
  ...(weights.compact ? [] : ["levelTwo"]),
  "filteredTexture",
  "previousAccumulated",
  "previousDenoised",
  "previousAux",
  "previousTrust",
  "previousEvidence",
]
  .map(
    (name, i) => `@group(0) @binding(${i + 2}) var ${name}: texture_2d<f32>;`,
  )
  .join("\n")}
${BLOCKS}
${COARSE}
${BLOCK_FILTERED}
struct Output {
${targets("encoded")}
  @location(${groups.length}) evidence: vec4f,
${weights.compact ? `  @location(${groups.length + 1}) color: vec4f,` : ""}
};
// Bilinear, clamped to the edge; float depth has no filtering sampler.
fn previousDepth(uv: vec2f) -> f32 {
  let last: vec2i = vec2i(floor(P.size * 0.5)) - 1;
  let position: vec2f = uv * P.size * 0.5 - 0.5;
  let base: vec2f = floor(position);
  let t: vec2f = position - base;
  let p0: vec2i = clamp(vec2i(base), vec2i(0), last);
  let p1: vec2i = clamp(vec2i(base) + 1, vec2i(0), last);
  let top: f32 = mix(textureLoad(depthPrevious, vec2i(p0.x, p0.y), 0).r, textureLoad(depthPrevious, vec2i(p1.x, p0.y), 0).r, t.x);
  let bottom: f32 = mix(textureLoad(depthPrevious, vec2i(p0.x, p1.y), 0).r, textureLoad(depthPrevious, vec2i(p1.x, p1.y), 0).r, t.x);
  return mix(top, bottom, t.y);
}
// The mean of the previous frame's state over where a block was: a bilinear
// tap in the middle of each of the block's quarters, which is that quarter's
// mean.
fn blockMean(state: texture_2d<f32>, centre: vec2f) -> vec4f {
  return 0.25 * (
    textureSampleLevel(state, linearSampler, centre + vec2f(-1.0, -1.0) * P.invSize, 0.0) +
    textureSampleLevel(state, linearSampler, centre + vec2f(1.0, -1.0) * P.invSize, 0.0) +
    textureSampleLevel(state, linearSampler, centre + vec2f(-1.0, 1.0) * P.invSize, 0.0) +
    textureSampleLevel(state, linearSampler, centre + vec2f(1.0, 1.0) * P.invSize, 0.0));
}
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let block: vec2i = vec2i(position.xy);
  let p: vec2i = block * 4;
  // The block's colour and its filtered colour: the means of the frame and
  // of the filtered frame over its sixteen pixels. The block's colour does
  // not stand for both: the filter moves light across the block's border, so
  // beside a thin bright line the two differ for good, and a still view would
  // read as one that keeps changing.
  let color: vec4f = ${weights.compact ? "textureSampleLevel(levelOne, linearSampler, position.xy * 2.0 / vec2f(textureDimensions(levelOne)), 0.0)" : "textureLoad(levelTwo, block, 0)"};
  let filtered: vec4f = blockFiltered(block, color);
  // How far a pixel is from the mean of its 2x2 neighbours, over the block's
  // first four pixels: nothing on clean content, about the noise level on
  // stochastic Splats.
  let around: f32 = luma(textureLoad(levelOne, block * 2, 0).rgb);
  var rough: f32 = 0.0;
  for (var j: i32 = 0; j < 4; j++) {
    let q: vec2i = min(p + vec2i(j & 1, j >> 1), vec2i(P.size) - 1);
    rough += abs(luma(frameLoad(colorTexture, q).rgb) - around);
  }
  var sr: vec4f = vec4f(0.0);
  var dr: vec4f = vec4f(0.0);
  var aux: vec4f = vec4f(0.0);
  var motion: f32 = 0.0;
  var trust: vec2f = vec2f(0.0);
  var valid: f32 = 0.0;
  var relative: f32 = 0.0;
  var kept: vec4f = vec4f(0.0);
  if (P.historyValid > 0.5) {
    let h: History = reproject(vec2f(p) + 0.5, blockDepth(p));
    valid = h.valid;
    // The block's middle, a pixel and a half from its top-left pixel's.
    let centre: vec2f = h.uv + 1.5 * P.invSize;
    sr = blockMean(previousAccumulated, centre);
    dr = blockMean(previousDenoised, centre);
    aux = blockMean(previousAux, centre);
    motion = h.motion / (h.motion + ${float(weights.motionKnee)});
    trust = coarse(previousTrust, centre * P.size, 4.0).xy * valid;
    // The evidence is about the accumulated history, so it fades with it.
    kept = coarse(previousEvidence, centre * P.size, 4.0) * trust.x;
    // The depth kept for a 2x2 block sits at the block's middle, half a
    // pixel from its top-left pixel: read there, a still view gets its own
    // block's depth back and not a mix with its neighbours'.
    let zp: f32 = previousDepth(h.uv + 0.5 * P.invSize);
    relative = clamp(abs(zp - h.previousZ) / max(max(zp, h.previousZ), 1e-6), 0.0, 1.0) * valid;
  }
  let ys: f32 = luma(sr.rgb);
  let ydr: f32 = luma(dr.rgb);
  // Single-sample subpixel coverage can alternate across a still edge and
  // repeatedly reject its history. Soften only the network's change features
  // when the block's variation can explain that change. A change continuing
  // the previous signed evidence keeps the full response to moving content.
  // The raw samples and spatial fallback below remain the current frame's.
  let samplingDeviation: f32 = sqrt(max(aux.x - ys * ys, 0.0));
  let change: f32 = max(luma(abs(color.rgb - sr.rgb)), luma(abs(filtered.rgb - dr.rgb)));
  let persistentChange: bool = (luma(filtered.rgb) - aux.w) * kept.x > 0.0;
  let featureBlend: f32 = 0.5 * P.cameraStill * valid * select(1.0, 0.0, persistentChange) * samplingDeviation / max(max(samplingDeviation, change), 1e-6);
  let featureColor: vec4f = mix(color, sr, featureBlend);
  let featureFiltered: vec4f = mix(filtered, dr, featureBlend);
  let y: f32 = luma(featureColor.rgb);
  let yd: f32 = luma(featureFiltered.rgb);
  let lowpass: f32 = abs(yd - ydr);
  let slowNow: f32 = abs(aux.w - yd) * valid;
  let slowFast: f32 = abs(aux.w - ydr) * valid;
  let deviation: f32 = sqrt(max(aux.x - ys * ys, 0.0) + 1e-8) * valid;
  // The signed difference between the block's filtered luma and its slow
  // luma, as running means over a few frames: a change that lasts, where one
  // frame would prove nothing.
  let evidence: vec4f = kept + ((yd - aux.w) * valid - kept) * ${vec4(weights.evidenceFrames.map((length) => 1 / length))};
  let gap: vec4f = abs(evidence);
  let ratio: vec4f = min(gap / (deviation + 0.02), vec4f(4.0));
  let held: vec2f = chroma(sr.rgb);
  let now: vec2f = chroma(featureColor.rgb) - held;
  let apart: vec2f = held - chroma(dr.rgb);
  let cd: vec2f = chroma(featureFiltered.rgb) - chroma(dr.rgb);
  let colorHeld: f32 = sqrt(dot(apart, apart) + 1e-12) * valid;
  let distance: f32 = sqrt((yd - ydr) * (yd - ydr) + dot(cd, cd) + 1e-12);
  let fs0: vec4f = vec4f(abs(y - ys), trust.x, motion * motion, aux.y * valid / ${float(weights.accumulatedFrames)});
  let fs1: vec4f = vec4f(motion, relative, relative * motion, lowpass);
  let fs2: vec4f = vec4f(slowNow, slowFast, deviation, 0.25 * rough);
  let fs5: vec4f = vec4f(
    sqrt(dot(now, now) + 1e-12) * valid, colorHeld,
    sqrt(dot(cd, cd) + 1e-12) * valid, min(colorHeld / (deviation + 0.02), 4.0));
  let fs6: vec4f = vec4f(trust.y, aux.z * valid / ${float(weights.denoisedFrames)}, ydr, distance);
  var out: Output;
${groups
  .map(
    (g) =>
      `  out.encoded${g} = silu(${mixed("ENCODE", g, ["fs0", "fs1", "fs2", "gap", "ratio", "fs5", "fs6"])});`,
  )
  .join("\n")}
  out.evidence = roundedHalf(evidence);
${weights.compact ? "  out.color = color;" : ""}
  return out;
}`;
  // First stage: a 3x3 depthwise layer and two pointwise ones.
  const stage = /* wgsl */ `${PARAMS}${TAPS}
${depthwise("DEPTHWISE", net.depthwise1)}
${pointwise("POINTWISE1", net.pointwise1)}
${pointwise("POINTWISE2", net.pointwise2)}
${inputTextures}
${BOUNDED}
struct Output {
${targets("stage")}
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p: vec2i = vec2i(position.xy);
${depthwiseTaps("DEPTHWISE", groups, "boundedBlock")}
${groups
  .map(
    (g) =>
      `  let b${g}: vec4f = silu(${mixed(
        "POINTWISE1",
        g,
        groups.map((i) => `a${i}`),
      )});`,
  )
  .join("\n")}
  var out: Output;
${groups
  .map(
    (g) =>
      `  out.stage${g} = silu(${mixed(
        "POINTWISE2",
        g,
        groups.map((i) => `b${i}`),
      )});`,
  )
  .join("\n")}
  return out;
}`;
  // Last stage and the head: what to trust, per block.
  const hidden = groups.map((g) => `b${g}`);
  const predict = /* wgsl */ `${PARAMS}${TAPS}
${depthwise("DEPTHWISE", net.depthwise2)}
${pointwise("POINTWISE", net.pointwise3)}
${head("ACCUMULATED", net.head, 0)}
${head("STABILIZE", net.head, 1)}
${head("SHARE", net.head, 2)}
${head("FILTER", net.head, 3)}
${head("DENOISED", net.head, 4)}
${inputTextures}
@group(0) @binding(${2 + groups.length}) var depthBlocks: texture_2d<f32>;
${BLOCKS}
struct Output {
  @location(0) trust: vec4f,
  @location(1) strength: vec4f,
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p: vec2i = vec2i(position.xy);
${depthwiseTaps("DEPTHWISE", groups, "boundedBlock")}
${groups
  .map(
    (g) =>
      `  let b${g}: vec4f = silu(${mixed(
        "POINTWISE",
        g,
        groups.map((i) => `a${i}`),
      )});`,
  )
  .join("\n")}
  // Trust is void where the block's own history is.
  var valid: f32 = 0.0;
  if (P.historyValid > 0.5) {
    valid = reproject(vec2f(p * 4) + 0.5, blockDepth(p * 4)).valid;
  }
  var out: Output;
  // Accumulated history, denoised history, the stabilization blend, and the
  // share of the gate's weight the accumulated path keeps.
  out.trust = vec4f(
    sigmoid(${headed("ACCUMULATED", hidden)}),
    sigmoid(${headed("DENOISED", hidden)}),
    sigmoid(${headed("STABILIZE", hidden)}),
    sigmoid(${headed("SHARE", hidden)})) * valid;
  // How much of the spatial filter this frame needs. It concerns the current
  // frame only, so missing history does not void it.
  out.strength = vec4f(sigmoid(${headed("FILTER", hidden)}), 0.0, 0.0, 1.0);
  return out;
}`;
  // Everything that happens per pixel: the spatial filter of the frame, the
  // history seen from the current view, the two running means with their
  // statistics, and the gated mix of the two.
  const resolve = /* wgsl */ `${PARAMS}${pixelCorrection(weights.correction)}
@group(0) @binding(2) var depthBlocks: texture_2d<f32>;
@group(0) @binding(3) var filteredTexture: texture_2d<f32>;
@group(0) @binding(4) var colorTexture: texture_2d<f32>;
@group(0) @binding(5) var previousAccumulated: texture_2d<f32>;
@group(0) @binding(6) var previousDenoised: texture_2d<f32>;
@group(0) @binding(7) var previousAux: texture_2d<f32>;
@group(0) @binding(8) var trustBlocks: texture_2d<f32>;
@group(0) @binding(9) var strengthBlocks: texture_2d<f32>;
@group(0) @binding(10) var previousOutput: texture_2d<f32>;
// What a pixel without history falls back on: the learned filter's
// half-resolution result.
@group(0) @binding(11) var wideTexture: texture_2d<f32>;
@group(0) @binding(12) var depthPrevious: texture_2d<f32>;
${weights.compact ? COMPACT_FILTER : ""}${BLOCKS}
// The frame's existing 4x4 mean, used only for rejected surfaces.
@group(0) @binding(13) var rejectedTexture: texture_2d<f32>;
${COARSE}
// The previous frame's second moment of luma, history lengths and slow luma
// at a position between its pixels. Beside a place whose history was just
// dropped, the colours read there are a mix of a long mean and one raw sample,
// as noisy as the sample. A length interpolated like the other values would
// call that mix settled, and the gate showed it: a bright dot before an empty
// background, a dark one on a bright wall. Read through its reciprocal, the
// accumulated history's length is decided by the shortest of the four, and
// is the same wherever the four agree.
fn previousStatistics(uv: vec2f) -> vec4f {
  let position: vec2f = uv * P.size - 0.5;
  let base: vec2f = floor(position);
  let t: vec2f = position - base;
  let p: vec2i = vec2i(base);
  let a: vec4f = textureLoad(previousAux, bounded(p), 0);
  let b: vec4f = textureLoad(previousAux, bounded(p + vec2i(1, 0)), 0);
  let c: vec4f = textureLoad(previousAux, bounded(p + vec2i(0, 1)), 0);
  let d: vec4f = textureLoad(previousAux, bounded(p + vec2i(1, 1)), 0);
  let w: vec4f = vec4f((1.0 - t.x) * (1.0 - t.y), t.x * (1.0 - t.y), (1.0 - t.x) * t.y, t.x * t.y);
  let mean: vec4f = a * w.x + b * w.y + c * w.z + d * w.w;
  return vec4f(mean.x, 1.0 / dot(w, 1.0 / vec4f(a.y, b.y, c.y, d.y)), mean.z, mean.w);
}
struct Output {
  @location(0) accumulated: vec4f,
  @location(1) denoised: vec4f,
  @location(2) aux: vec4f,
  @location(3) shown: vec4f,
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p: vec2i = vec2i(position.xy);
  let d: vec4f = ${weights.compact ? "mix(frameLoad(colorTexture, p), compactFiltered(position.xy), 0.5)" : "textureLoad(filteredTexture, p, 0)"};
  let color: vec4f = frameLoad(colorTexture, p);
  var sr: vec4f = vec4f(0.0);
  var dr: vec4f = vec4f(0.0);
  // Second moment of luma, the two history lengths, slow low-pass luma.
  var aux: vec4f = vec4f(0.0);
  // The image shown last frame, and what it spans around this pixel.
  var previous: Resampled;
  var valid: f32 = 0.0;
  // How fast the camera changes the image here, in pixels per frame.
  var speed: f32 = 0.0;
  // 0 where the history read here belonged to another surface.
  var same: f32 = 1.0;
  let sparse: f32 = blockSparse(p);
  var sparseMotion: f32 = 0.0;
  if (P.historyValid > 0.5) {
    let z: f32 = blockDepth(p);
    let h: History = reproject(position.xy, z);
    valid = h.valid;
    // The pixel's own motion, or what a turn of the camera sweeps over half
    // the view, whichever is more: at the centre of a turn the first is
    // small while every surface there shows a new face. An orthographic
    // camera sweeps in proportion to the distance.
    let sweep: f32 = P.turn * 0.25 * P.size.y * P.unprojectA.y * select(1.0, z, P.unprojectB.z == 0.0);
    speed = max(h.motion, sweep);
    // The network judges depth for a 4x4 block from one of its pixels, so a
    // sliver of a block can read the history of whatever the camera's motion
    // has just uncovered or covered there, and a dark surface's history then
    // stands in a bright one as a dot. Each pixel compares the depth its own
    // surface had in the previous view with the depth the previous frame kept
    // for the 2x2 block it reads from. The test follows the camera's speed
    // and is void on a still view, where a pixel reads its own place and
    // stochastic depth merely flips between the layers seen there.
    let seen: f32 = textureLoad(depthPrevious, clamp(vec2i(floor(h.uv * P.size * 0.5)), vec2i(0), vec2i(floor(P.size * 0.5)) - 1), 0).r;
    let other: f32 = f32(abs(seen - h.previousZ) > ${float(weights.surfaceApart)} * max(seen, h.previousZ));
    same = 1.0 - other * speed * speed / (speed * speed + ${float(weights.surfaceKnee * weights.surfaceKnee)});
    previous = catmullRomSpan(previousOutput, h.uv);
    var a: vec4f;
    if (P.cameraStill > 0.5) {
      // Object motion still goes through the network and history rejection.
      // Only camera reprojection needs interpolation between history pixels.
      sr = max(textureLoad(previousAccumulated, p, 0), vec4f(0.0));
      dr = max(textureLoad(previousDenoised, p, 0), vec4f(0.0));
      a = textureLoad(previousAux, p, 0);
      previous.value = textureLoad(previousOutput, p, 0);
    } else {
${
  weights.compact
    ? `      sr = max(textureSampleLevel(previousAccumulated, linearSampler, h.uv, 0.0), vec4f(0.0));
      dr = max(textureSampleLevel(previousDenoised, linearSampler, h.uv, 0.0), vec4f(0.0));
      a = previousStatistics(h.uv);
      // Reuse the sharp display history already read for its clamp span.`
    : `      let interpolation: LanczosKernel = lanczosKernel(h.uv);
      sr = max(lanczosCross(previousAccumulated, interpolation), vec4f(0.0));
      dr = max(lanczosCross(previousDenoised, interpolation), vec4f(0.0));
      a = previousStatistics(h.uv);
      previous.value = lanczosCross(previousOutput, interpolation);`
}
    }
    // Where a block has no depth of its own, where to read its history is a
    // guess, so while the camera moves it keeps little of the accumulated
    // history, and what was misread fades in a few frames.
    sparseMotion = sparse * speed * speed / (speed * speed + ${float(weights.sparseKnee * weights.sparseKnee)});
    let limit: f32 = mix(${float(weights.accumulatedFrames)}, ${float(weights.sparseFrames)}, sparseMotion);
    aux = vec4f(a.x, min(a.y * valid * same, limit), a.z * valid * same, a.w);
  }
  ${weights.correction ? "var" : "let"} trust: vec4f = coarse(trustBlocks, position.xy, 4.0) * valid * same;
  ${weights.correction ? "var" : "let"} strength: f32 = coarse(strengthBlocks, position.xy, 4.0).r;
${
  weights.correction
    ? `  let corrected: vec4f = correctedPixels(color, d, sr, dr, aux, trust, strength);
  trust = vec4f(corrected.xy, trust.z, corrected.z);
  strength = corrected.w;`
    : ""
}

  // Accumulated path: raw samples. It converges to the blended image.
  let yc: f32 = luma(color.rgb);
  let ws: f32 = aux.y * trust.x;
  let ds: f32 = ws + 1.0;
  let s: vec4f = (sr * ws + color) / ds;
  // Kept finite: an infinite square in a half-float mean never recovers.
  let y2: f32 = (aux.x * ws + min(yc * yc, 30000.0)) / ds;
  let slow: f32 = (aux.w * ws + luma(d.rgb)) / ds;
  let ns: f32 = min(ds, ${float(weights.accumulatedFrames)});
  // Denoised path: spatially filtered frames, with a short history.
  let wh: f32 = aux.z * trust.y;
  let dh: f32 = wh + 1.0;
  // With no history to average it with, the frame's filter has to do all
  // the averaging, and one that keeps detail leaves a single dark or bright
  // sample standing as a dot. Where the camera also changes the image too
  // fast for that detail to be seen, or the history was another surface's,
  // the path takes a wider filter's result, in which every sample is already
  // spread out.
  let fast: f32 = speed * speed / (speed * speed + ${float(weights.motionKnee * weights.motionKnee)});
  ${
    weights.sparseWide
      ? `// Where too little is drawn for a depth, a frame is single samples before
  // nothing, which the learned filter leaves standing at any camera speed.
  let short: f32 = max(exp(-wh / ${float(weights.reach)}) * max(fast, sparse), 1.0 - same);`
      : `let short: f32 = max(exp(-wh / ${float(weights.reach)}) * fast, 1.0 - same);`
  }
  let wide: vec4f = ${weights.compact ? "mix(coarse(wideTexture, position.xy, 2.0), coarse(rejectedTexture, position.xy, 4.0), 0.5)" : "coarse(wideTexture, position.xy, 2.0)"};
  var current: vec4f = mix(mix(color, d, strength), wide, short);
  // Strengthen only the share whose history belonged to another surface.
  // Normal fast motion keeps the learned fallback's detail.
  let rejected: vec4f = coarse(rejectedTexture, position.xy, 4.0);
  current += (rejected - wide) * (1.0 - same) * ${float(weights.surfaceWide)};
  let dn: vec4f = (dr * wh + current) / dh;
  let nh: f32 = min(dh, ${float(weights.denoisedFrames)});

  // The accumulated path's weight grows with its history and falls with the
  // standard error of its mean; the network scales it once more.
  let ys: f32 = luma(s.rgb);
  let error: f32 = sqrt(max(y2 - ys * ys, 0.0) / (ns + 1e-3) + 1e-10);
  let ramp: f32 = 1.0 - exp(-ns / ${float(weights.gateFrames)});
  let keep: f32 = ramp * (1.0 - clamp(${float(weights.gamma)} * error, 0.0, 1.0)) * trust.w;
  let composite: vec4f = mix(dn, s, keep);
  // Stabilization: a predicted blend with the previous image, which may stay
  // as far from this frame's result as half of what it spans around the
  // pixel, plus a slack. Taking that span from this frame's result instead
  // would need it in a texture first and a pass of its own; on the test
  // sets the two measured the same. The blend is void where the pixel has no
  // usable history.
  let tolerance: vec4f = 0.5 * previous.span + ${float(weights.stabilizeSlack)};
  let clamped: vec4f = clamp(previous.value, composite - tolerance, composite + tolerance);
  var out: Output;
  out.accumulated = roundedHalf(s);
  out.denoised = roundedHalf(dn);
  out.aux = roundedHalf(vec4f(y2, ns, nh, slow));
  // Borrowed depth also makes the displayed history uncertain during motion.
  ${weights.stabilizeNoise ? "var" : "let"} stabilize: f32 = ${float(weights.stabilizeBlend)} * trust.z * mix(1.0, ${float(weights.sparseStabilize)}, sparseMotion);
${
  weights.stabilizeNoise
    ? `  // A single coverage sample can change brightness even where history is
  // usable. Retain more of the displayed image when that change fits the
  // accumulated noise; large changes and rejected history keep responding.
  let difference: f32 = luma(abs(composite.rgb - previous.value.rgb));
  let uncertainty: f32 = 16.0 * error * error;
  let confidence: f32 = uncertainty / (uncertainty + difference * difference + 1e-10);
  // Borrowed depth cannot anchor stronger stabilization while the view moves.
  stabilize = max(stabilize, ${float(weights.stabilizeBlend)} * trust.y * confidence * (1.0 - sparseMotion));`
    : ""
}
  out.shown = roundedHalf(mix(composite, clamped, stabilize * step(0.5, P.stabilize)));
  return out;
}`;
  return {
    cells: cells(multisampled),
    wider: WIDER,
    depth: depth(weights, multisampled),
    expose: expose(multisampled),
    encode: ENCODE,
    downsample: DOWNSAMPLE,
    features,
    stage,
    predict,
    resolve,
    rounding: ROUNDING,
    filter: learned,
    groups: groups.length,
  };
}
