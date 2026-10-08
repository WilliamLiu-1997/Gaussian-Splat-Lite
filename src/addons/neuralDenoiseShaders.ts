import type {
  NeuralDenoiseLayer,
  NeuralDenoiseModel,
} from "./neuralDenoiseWeights";

/** Floats in the uniform block shared by every pass; see PARAMS below. */
export const NEURAL_DENOISE_UNIFORM_FLOATS = 64;

const float = (value: number) => {
  const text = value.toPrecision(9);
  return /[.e]/.test(text) ? text : `${text}.0`;
};
const vec4 = (values: number[]) => `vec4f(${values.map(float).join(", ")})`;
const range = (count: number) => Array.from({ length: count }, (_, i) => i);

// Channels travel in groups of four, one vec4 or one render target each.

/** A pointwise layer: a mat4x4 per output and input group, NAME_<o>_<i>, and a bias NAME_b<o>. */
function pointwise(name: string, { w, b }: NeuralDenoiseLayer) {
  const inputs = w.length / b.length;
  const lines: string[] = [];
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
const mixed = (name: string, group: number, inputs: string[]) =>
  `${inputs.map((x, i) => `${name}_${group}_${i} * ${x}`).join(" + ")} + ${name}_b${group}`;

/** A depthwise 3x3 layer: nine tap weights NAME_<group> and a bias NAME_b<group>. */
function depthwise(name: string, { w, b }: NeuralDenoiseLayer) {
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
function head(name: string, { w, b }: NeuralDenoiseLayer, output: number) {
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
const headed = (name: string, inputs: string[]) =>
  `${inputs.map((x, i) => `dot(${name}_${i}, ${x})`).join(" + ")} + ${name}_b`;

/** Reads a layer's input textures through a 3x3 depthwise layer into a0, a1, ... and applies SiLU. */
const depthwiseTaps = (name: string, groups: number[]) => /* wgsl */ `
${groups.map((g) => `  var a${g} = ${name}_b${g};`).join("\n")}
  for (var j = 0; j < 9; j++) {
    let q = boundedHalf(p + TAPS[j]);
${groups.map((g) => `    a${g} += ${name}_${g}[j] * textureLoad(input${g}, q, 0);`).join("\n")}
  }
${groups.map((g) => `  a${g} = silu(a${g});`).join("\n")}`;

const VERTEX = /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}`;

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
  jitter: vec2f,       // this frame's samples relative to pixel centres, in pixels
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var linearSampler: sampler;
${VERTEX}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.25, 0.5, 0.25)); }
fn chroma(c: vec3f) -> vec2f {
  return vec2f(0.5 * (c.r - c.b), -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn silu(x: vec4f) -> vec4f { return x / (1.0 + exp(-x)); }
fn sigmoid(x: f32) -> f32 { return 1.0 / (1.0 + exp(-x)); }
fn bounded(p: vec2i) -> vec2i { return clamp(p, vec2i(0), vec2i(P.size) - 1); }
// The trust networks run on 2x2 blocks, in an image of half the size.
fn boundedHalf(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(floor(P.size * 0.5)) - 1);
}

// Some GPUs truncate a float written to a half-float target instead of
// rounding it. A running mean over 128 frames then loses half a unit in the
// last place on every write and drifts several percent too dark. Adding the
// measured bias (half a unit where the GPU truncates, nothing where it
// rounds) makes every write round to nearest.
fn roundedHalf(v: vec4f) -> vec4f {
  let magnitude = max(abs(v), vec4f(6.1035156e-5));
  return v + sign(v) * P.halfBias * exp2(floor(log2(magnitude)) - 10.0);
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
  let uv = pixel * P.invSize;
  let zv = -z;
  let cw = P.unprojectB.z * zv + P.unprojectB.w;
  let x = ((2.0 * uv.x - 1.0) * cw - P.unprojectA.z * zv - P.unprojectB.x) / P.unprojectA.x;
  let y = ((1.0 - 2.0 * uv.y) * cw - P.unprojectA.w * zv - P.unprojectB.y) / P.unprojectA.y;
  let position = vec4f(x, y, zv, 1.0);
  let previous = P.toPrevClip * position;
  let current = P.toClip * position;
  var w = previous.w;
  if (abs(w) < 1e-8) { w = 1e-8; }
  let motion = current.xy / current.w - previous.xy / w;
  var h: History;
  h.uv = uv + vec2f(-0.5, 0.5) * motion;
  h.valid = f32(previous.w > 0.0 && all(h.uv >= vec2f(0.0)) && all(h.uv <= vec2f(1.0)));
  h.motion = length(0.5 * P.size * motion);
  h.previousZ = -dot(P.toPrevViewZ, position);
  return h;
}

// Catmull-Rom from five bilinear taps: the four corner taps of the nine-tap
// form are dropped and the rest renormalised. On the trained model the two
// differ by less than 0.05 dB.
fn catmullRom(image: texture_2d<f32>, uv: vec2f) -> vec4f {
  let position = uv * P.size;
  let center = floor(position - 0.5) + 0.5;
  let t = position - center;
  let w0 = t * (-0.5 + t * (1.0 - 0.5 * t));
  let w1 = 1.0 + t * t * (-2.5 + 1.5 * t);
  let w2 = t * (0.5 + t * (2.0 - 1.5 * t));
  let w3 = t * t * (-0.5 + 0.5 * t);
  let w12 = w1 + w2;
  let p0 = (center - 1.0) * P.invSize;
  let p12 = (center + w2 / w12) * P.invSize;
  let p3 = (center + 2.0) * P.invSize;
  var result = textureSampleLevel(image, linearSampler, vec2f(p12.x, p12.y), 0.0) * (w12.x * w12.y);
  result += textureSampleLevel(image, linearSampler, vec2f(p0.x, p12.y), 0.0) * (w0.x * w12.y);
  result += textureSampleLevel(image, linearSampler, vec2f(p3.x, p12.y), 0.0) * (w3.x * w12.y);
  result += textureSampleLevel(image, linearSampler, vec2f(p12.x, p0.y), 0.0) * (w12.x * w0.y);
  result += textureSampleLevel(image, linearSampler, vec2f(p12.x, p3.y), 0.0) * (w12.x * w3.y);
  return result / (w12.x * w12.y + (w0.x + w3.x) * w12.y + w12.x * (w0.y + w3.y));
}
`;

const TAPS = /* wgsl */ `
const TAPS = array<vec2i, 9>(
  vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1),
  vec2i(-1, 0), vec2i(0, 0), vec2i(1, 0),
  vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1));
`;

// Single noisy frames cannot tell slow motion from noise: on strongly noisy
// content a still block looks changed every few frames. So the difference
// between a block's filtered luma and its slow luma is kept, with its sign,
// as running means over a few frames. Noise changes sign and averages out; a
// change that lasts does not. Only the difference is stored, never image
// content, so reprojecting it while the camera moves blurs noise away rather
// than inventing edges. A pass that calls this declares depthFixed, filtered,
// auxTexture, previousTrust and previousEvidence. `block` is the block's
// top-left pixel.
const evidence = (frames: number[]) => /* wgsl */ `
fn laggingEvidence(block: vec2i) -> vec4f {
  let corner = (vec2f(block) + 1.0) * P.invSize;
  var previous = vec4f(0.0);
  var valid = 0.0;
  if (P.historyValid > 0.5) {
    let h = followed(reproject(vec2f(block) + 0.5, textureLoad(depthFixed, block, 0).r), vec2f(block) + 0.5);
    valid = h.valid;
    // The evidence is about the accumulated history, so it fades with it:
    // what the last frame's trust dropped is forgotten here as well.
    let kept = textureSampleLevel(previousTrust, linearSampler, h.uv, 0.0).x * h.valid;
    // Read at the block's centre, which a still view maps onto one texel. It
    // accumulates, so any other point would blur it a little every frame.
    previous = textureSampleLevel(previousEvidence, linearSampler, h.uv + 0.5 * P.invSize, 0.0) * kept;
  }
  let yd = luma(textureSampleLevel(filtered, linearSampler, corner, 0.0).rgb);
  let slow = textureSampleLevel(auxTexture, linearSampler, corner, 0.0).w;
  return previous + ((yd - slow) * valid - previous) * ${vec4(frames.map((length) => 1 / length))};
}`;

/**
 * The WGSL of every pass, with the trained weights written in as constants.
 * Each fragment shader's bindings are: the uniform block, a linear sampler,
 * then its textures in the order they are declared.
 */
export function neuralDenoiseShaders(weights: NeuralDenoiseModel) {
  const net = weights.network;
  // The network's hidden channels, in groups of four.
  const groups = range(net.encode.b.length / 4);
  const inputTextures = groups
    .map((g) => `@group(0) @binding(${2 + g}) var input${g}: texture_2d<f32>;`)
    .join("\n");
  const targets = (name: string) =>
    groups.map((g) => `  @location(${g}) ${name}${g}: vec4f,`).join("\n");
  // A model that follows motion reads history where the content was, not only
  // where the camera says the pixel was. The shift, in pixels, comes from the
  // motion passes below, at half resolution; every pass that reprojects takes
  // it as its last texture. A model that does not follow keeps the camera's
  // answer.
  const follow = weights.follow;
  const following = (binding: number) =>
    follow
      ? /* wgsl */ `
@group(0) @binding(${binding}) var shiftTexture: texture_2d<f32>;
fn followed(h: History, pixel: vec2f) -> History {
  var moved = h;
  moved.uv = h.uv - textureSampleLevel(shiftTexture, linearSampler, pixel * P.invSize, 0.0).xy * P.invSize;
  moved.valid = h.valid * f32(all(moved.uv >= vec2f(0.0)) && all(moved.uv <= vec2f(1.0)));
  return moved;
}`
      : "fn followed(h: History, pixel: vec2f) -> History { return h; }";
  // The kernel reads two neighbouring levels of the frame's image pyramid.
  const level = Math.min(Math.max(Math.log2(weights.blur), 0), 3);
  const lowLevel = Math.min(Math.floor(level), 2);

  // The view depth reprojection uses, one value per pixel.
  const depth = /* wgsl */ `${PARAMS}${TAPS}
@group(0) @binding(2) var depthTexture: texture_depth_2d;
fn viewDepth(d: f32) -> f32 {
  if (P.logDepth > 0.5) { return P.logNear * exp2(d * P.logFar); }
  return -(P.depth.z - d * P.depth.w) / (d * P.depth.y - P.depth.x);
}
// Stochastic depth is whichever layer survived at each pixel, so it jumps
// between layers from frame to frame. The third nearest of the neighbourhood,
// with empty pixels at far, ignores a faint layer in front that one or two
// pixels hit, yet keeps a one-pixel line or a foreground edge.
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = vec2i(position.xy);
  var nearest = vec3f(3.0e38);
  for (var j = 0; j < 9; j++) {
    let d = textureLoad(depthTexture, bounded(p + TAPS[j]), 0);
    var z = P.far;
    if (d != P.clearDepth) { z = viewDepth(d); }
    let a = max(nearest.x, z);
    let b = max(nearest.y, a);
    nearest = vec3f(min(nearest.x, z), min(nearest.y, a), min(nearest.z, b));
  }
  return vec4f(nearest.z, 0.0, 0.0, 1.0);
}`;

  // The networks were trained on display-referred values. A linear working
  // colour space is encoded on the way in and decoded by the output node.
  const encode = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = textureLoad(image, vec2i(position.xy), 0);
  // Premultiplied: the transfer applies to the colour itself.
  let alpha = max(c.a, 1e-6);
  let x = max(c.rgb / alpha, vec3f(0.0));
  let encoded = select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
  return vec4f(encoded * alpha, c.a);
}`;

  const downsample = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = floor(vec2f(textureDimensions(image)) * 0.5);
  return textureSampleLevel(image, linearSampler, position.xy / size, 0.0);
}`;

  // Spatial filter of the frame, and the history seen from the current view.
  const reproject = /* wgsl */ `${PARAMS}
@group(0) @binding(2) var depthFixed: texture_2d<f32>;
@group(0) @binding(3) var levelLow: texture_2d<f32>;
@group(0) @binding(4) var levelHigh: texture_2d<f32>;
@group(0) @binding(5) var previousAccumulated: texture_2d<f32>;
@group(0) @binding(6) var previousDenoised: texture_2d<f32>;
@group(0) @binding(7) var previousAux: texture_2d<f32>;
${following(8)}
struct Output {
  @location(0) accumulated: vec4f,
  @location(1) denoised: vec4f,
  @location(2) aux: vec4f,
  @location(3) filtered: vec4f,
};
fn probe(uv: vec2f) -> vec4f {
  return mix(
    textureSampleLevel(levelLow, linearSampler, uv, 0.0),
    textureSampleLevel(levelHigh, linearSampler, uv, 0.0),
    ${float(level - lowLevel)});
}
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let uv = position.xy * P.invSize;
  let offset = ${float(0.5 * weights.blur)} * P.invSize;
  var out: Output;
  // A fixed isotropic kernel: four trilinear probes on a square.
  out.filtered = roundedHalf(0.25 * (
    probe(uv + vec2f(-offset.x, -offset.y)) + probe(uv + vec2f(offset.x, -offset.y)) +
    probe(uv + vec2f(-offset.x, offset.y)) + probe(uv + vec2f(offset.x, offset.y))));
  out.accumulated = vec4f(0.0);
  out.denoised = vec4f(0.0);
  out.aux = vec4f(0.0);
  if (P.historyValid > 0.5) {
    let h = followed(reproject(position.xy, textureLoad(depthFixed, vec2i(position.xy), 0).r), position.xy);
    out.accumulated = roundedHalf(max(catmullRom(previousAccumulated, h.uv), vec4f(0.0)));
    out.denoised = roundedHalf(max(catmullRom(previousDenoised, h.uv), vec4f(0.0)));
    // Second moment of luma, the two history lengths, slow low-pass luma.
    let a = textureSampleLevel(previousAux, linearSampler, h.uv, 0.0);
    out.aux = roundedHalf(vec4f(a.x, a.y * h.valid, a.z * h.valid, a.w));
  }
  return out;
}`;

  // The trust network's inputs and its first layer.
  const features = /* wgsl */ `${PARAMS}
${pointwise("ENCODE", net.encode)}
@group(0) @binding(2) var depthFixed: texture_2d<f32>;
@group(0) @binding(3) var depthPrevious: texture_2d<f32>;
@group(0) @binding(4) var colorTexture: texture_2d<f32>;
@group(0) @binding(5) var accumulated: texture_2d<f32>;
@group(0) @binding(6) var denoised: texture_2d<f32>;
@group(0) @binding(7) var auxTexture: texture_2d<f32>;
@group(0) @binding(8) var filtered: texture_2d<f32>;
@group(0) @binding(9) var previousTrust: texture_2d<f32>;
@group(0) @binding(10) var previousEvidence: texture_2d<f32>;
${following(11)}
${evidence(weights.evidenceFrames)}
struct Output {
${targets("encoded")}
};
// Bilinear, clamped to the edge; float depth has no filtering sampler.
fn previousDepth(uv: vec2f) -> f32 {
  let position = uv * P.size - 0.5;
  let base = floor(position);
  let t = position - base;
  let p0 = bounded(vec2i(base));
  let p1 = bounded(vec2i(base) + 1);
  let top = mix(textureLoad(depthPrevious, vec2i(p0.x, p0.y), 0).r, textureLoad(depthPrevious, vec2i(p1.x, p0.y), 0).r, t.x);
  let bottom = mix(textureLoad(depthPrevious, vec2i(p0.x, p1.y), 0).r, textureLoad(depthPrevious, vec2i(p1.x, p1.y), 0).r, t.x);
  return mix(top, bottom, t.y);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  // One half-resolution pixel stands for a 2x2 block. Its inputs are the
  // block's means, one bilinear tap at the corner the four pixels share; its
  // reprojection is that of the block's top-left pixel.
  let p = vec2i(position.xy) * 2;
  let corner = (vec2f(p) + 1.0) * P.invSize;
  let color = textureSampleLevel(colorTexture, linearSampler, corner, 0.0);
  let sr = textureSampleLevel(accumulated, linearSampler, corner, 0.0);
  let dr = textureSampleLevel(denoised, linearSampler, corner, 0.0);
  let aux = textureSampleLevel(auxTexture, linearSampler, corner, 0.0);
  let d = textureSampleLevel(filtered, linearSampler, corner, 0.0);
  var motion = 0.0;
  var trust = vec2f(0.0);
  var valid = 0.0;
  var relative = 0.0;
  if (P.historyValid > 0.5) {
    let h = followed(reproject(vec2f(p) + 0.5, textureLoad(depthFixed, p, 0).r), vec2f(p) + 0.5);
    valid = h.valid;
    motion = h.motion / (h.motion + ${float(weights.motionKnee)});
    trust = textureSampleLevel(previousTrust, linearSampler, h.uv, 0.0).xy * h.valid;
    let zp = previousDepth(h.uv);
    relative = clamp(abs(zp - h.previousZ) / max(max(zp, h.previousZ), 1e-6), 0.0, 1.0) * h.valid;
  }
  let yc = luma(color.rgb);
  let yd = luma(d.rgb);
  let ys = luma(sr.rgb);
  let ydr = luma(dr.rgb);
  let lowpass = abs(yd - ydr);
  // The slow low-pass luma lags exactly as the accumulated colour does, so its
  // distance to the current and to the fast filtered image reveals slow motion
  // that single noisy frames hide.
  let slowNow = abs(aux.w - yd) * valid;
  let slowFast = abs(aux.w - ydr) * valid;
  let deviation = sqrt(max(aux.x - ys * ys, 0.0) + 1e-8) * valid;
  // How far each pixel of the block is from its own filtered value: nothing
  // on clean content, about the noise level on stochastic Splats.
  var rough = 0.0;
  for (var j = 0; j < 4; j++) {
    let q = min(p + vec2i(j & 1, j >> 1), vec2i(P.size) - 1);
    rough += abs(luma(textureLoad(colorTexture, q, 0).rgb) - luma(textureLoad(filtered, q, 0).rgb));
  }
  let fs0 = vec4f(abs(yc - ys), trust.x, motion * motion, aux.y / ${float(weights.accumulatedFrames)});
  let fs1 = vec4f(motion, relative, relative * motion, lowpass);
  let fs2 = vec4f(slowNow, slowFast, deviation, 0.25 * rough);
  // A change that lasts, where one frame would prove nothing: as such, and
  // against the noise level.
  let gap = abs(laggingEvidence(p));
  let ratio = min(gap / (deviation + 0.02), vec4f(4.0));
  let cd = chroma(d.rgb) - chroma(dr.rgb);
  let distance = sqrt((yd - ydr) * (yd - ydr) + dot(cd, cd) + 1e-12);
  // Chroma. Everything above is a luma difference or a depth mismatch, so a
  // change of colour at about equal luma would go unseen: a translucent tinted
  // object that writes no depth leaves the accumulated path holding its tint.
  // The accumulated history's chroma against the frame at hand, and against
  // the denoised history, which follows the frame within a few frames; then
  // the filtered frame's against the denoised history.
  let held = chroma(sr.rgb);
  let now = chroma(color.rgb) - held;
  let apart = held - chroma(dr.rgb);
  let colorHeld = sqrt(dot(apart, apart) + 1e-12) * valid;
  let fs5 = vec4f(
    sqrt(dot(now, now) + 1e-12) * valid, colorHeld,
    sqrt(dot(cd, cd) + 1e-12) * valid, min(colorHeld / (deviation + 0.02), 4.0));
  // What the denoised path's trust needs besides: its previous value, its
  // history length, and how the filtered frame sits against its history.
  let fs6 = vec4f(trust.y, aux.z / ${float(weights.denoisedFrames)}, ydr, distance);
  var out: Output;
${groups
  .map(
    (g) =>
      `  out.encoded${g} = silu(${mixed("ENCODE", g, ["fs0", "fs1", "fs2", "gap", "ratio", "fs5", "fs6"])});`,
  )
  .join("\n")}
  return out;
}`;

  // First stage: a 3x3 depthwise layer and two pointwise ones.
  const stage = /* wgsl */ `${PARAMS}${TAPS}
${depthwise("DEPTHWISE", net.depthwise1)}
${pointwise("POINTWISE1", net.pointwise1)}
${pointwise("POINTWISE2", net.pointwise2)}
${inputTextures}
struct Output {
${targets("stage")}
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p = vec2i(position.xy);
${depthwiseTaps("DEPTHWISE", groups)}
${groups
  .map(
    (g) =>
      `  let b${g} = silu(${mixed(
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

  // Extra depth: residual blocks of the same three layers, added to their
  // input. A model has none, or one pass for each.
  const blocks = net.blocks.map(
    (block) => /* wgsl */ `${PARAMS}${TAPS}
${depthwise("DEPTHWISE", block.depthwise)}
${pointwise("POINTWISE1", block.pointwise1)}
${pointwise("POINTWISE2", block.pointwise2)}
${inputTextures}
struct Output {
${targets("block")}
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p = vec2i(position.xy);
${depthwiseTaps("DEPTHWISE", groups)}
${groups
  .map(
    (g) =>
      `  let b${g} = silu(${mixed(
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
      `  out.block${g} = textureLoad(input${g}, p, 0) + ${mixed(
        "POINTWISE2",
        g,
        groups.map((i) => `b${i}`),
      )};`,
  )
  .join("\n")}
  return out;
}`,
  );

  // Last stage and the head: what to trust, at half resolution.
  const extra = 2 + groups.length;
  const hidden = groups.map((g) => `b${g}`);
  const predict = /* wgsl */ `${PARAMS}${TAPS}
${depthwise("DEPTHWISE", net.depthwise2)}
${pointwise("POINTWISE", net.pointwise3)}
${head("ACCUMULATED", net.head, 0)}
${head("STABILIZE", net.head, 1)}
${head("SHARE", net.head, 2)}
${head("FILTER", net.head, 3)}
${head("DENOISED", net.head, 4)}
${follow ? `${pointwise("FOLLOW_HIDDEN", follow.network.hidden)}\n${head("FOLLOW_OUT", follow.network.out, 0)}` : ""}
${inputTextures}
@group(0) @binding(${extra}) var auxTexture: texture_2d<f32>;
@group(0) @binding(${extra + 1}) var depthFixed: texture_2d<f32>;
@group(0) @binding(${extra + 2}) var filtered: texture_2d<f32>;
@group(0) @binding(${extra + 3}) var previousTrust: texture_2d<f32>;
@group(0) @binding(${extra + 4}) var previousEvidence: texture_2d<f32>;
${follow ? `@group(0) @binding(${extra + 5}) var motionTexture: texture_2d<f32>;` : ""}
${following(extra + 6)}
${evidence(weights.evidenceFrames)}
struct Output {
  @location(0) trust: vec4f,
  @location(1) strength: vec4f,
  @location(2) evidence: vec4f,
${follow ? "  @location(3) flow: vec4f," : ""}
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p = vec2i(position.xy);
${depthwiseTaps("DEPTHWISE", groups)}
${groups
  .map(
    (g) =>
      `  let b${g} = silu(${mixed(
        "POINTWISE",
        g,
        groups.map((i) => `a${i}`),
      )});`,
  )
  .join("\n")}
  // Trust is void where the block's own history is. A reprojected history
  // length is at least one wherever history is usable.
  let valid = step(0.5, textureLoad(auxTexture, p * 2, 0).y);
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
  // The evidence with this frame in it, as the features pass saw it, kept for
  // the next frame.
  out.evidence = roundedHalf(laggingEvidence(p * 2));
${
  follow
    ? `  // Whether to follow the motion estimate next frame. A small network of
  // its own decides, from the estimate's size, how much of the difference
  // the camera leaves it has been removing, how far this frame disagrees
  // with it, and the probability given last frame. The trust network above
  // sees none of these: they are taken over a wide window, so beside a
  // moving edge they describe the edge and not the still content next to
  // it, and on a still view they are noise. A network that trusts history
  // by them flickers on still views and smears what a moving object left.
  let moving = textureLoad(motionTexture, p, 0);
  let correction = textureLoad(shiftTexture, p, 0).zw;
  let seen = vec4f(
    0.25 * sqrt(dot(moving.xy, moving.xy) + 1e-12), moving.z,
    0.5 * sqrt(dot(correction, correction) + 1e-12), moving.w);
  let weighed = array<vec4f, 2>(silu(${mixed("FOLLOW_HIDDEN", 0, ["seen"])}), silu(${mixed("FOLLOW_HIDDEN", 1, ["seen"])}));
  out.flow = roundedHalf(vec4f(moving.xyz, sigmoid(${headed("FOLLOW_OUT", ["weighed[0]", "weighed[1]"])}) * valid));`
    : ""
}
  return out;
}`;

  // The two running means, their statistics, and the gated mix of the two.
  const update = /* wgsl */ `${PARAMS}
@group(0) @binding(2) var colorTexture: texture_2d<f32>;
@group(0) @binding(3) var accumulated: texture_2d<f32>;
@group(0) @binding(4) var denoised: texture_2d<f32>;
@group(0) @binding(5) var auxTexture: texture_2d<f32>;
@group(0) @binding(6) var filtered: texture_2d<f32>;
@group(0) @binding(7) var trustHalf: texture_2d<f32>;
@group(0) @binding(8) var strengthHalf: texture_2d<f32>;
struct Output {
  @location(0) accumulated: vec4f,
  @location(1) denoised: vec4f,
  @location(2) aux: vec4f,
  @location(3) composite: vec4f,
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p = vec2i(position.xy);
  let uv = position.xy * P.invSize;
  let color = textureLoad(colorTexture, p, 0);
  let sr = textureLoad(accumulated, p, 0);
  let dr = textureLoad(denoised, p, 0);
  let aux = textureLoad(auxTexture, p, 0);
  let d = textureLoad(filtered, p, 0);
  let valid = step(0.5, aux.y);
  let trust = textureSampleLevel(trustHalf, linearSampler, uv, 0.0) * valid;
  let strength = textureSampleLevel(strengthHalf, linearSampler, uv, 0.0).r;

  // Accumulated path: raw samples. It converges to the blended image.
  let yc = luma(color.rgb);
  let ws = aux.y * trust.x;
  let ds = ws + 1.0;
  let s = (sr * ws + color) / ds;
  // Kept finite: an infinite square in a half-float mean never recovers.
  let y2 = (aux.x * ws + min(yc * yc, 30000.0)) / ds;
  let slow = (aux.w * ws + luma(d.rgb)) / ds;
  let ns = min(ds, ${float(weights.accumulatedFrames)});
  // Denoised path: spatially filtered frames, with a short history.
  let wh = aux.z * trust.y;
  let dh = wh + 1.0;
  let dn = (dr * wh + mix(color, d, strength)) / dh;
  let nh = min(dh, ${float(weights.denoisedFrames)});

  // The accumulated path's weight grows with its history and falls with the
  // standard error of its mean; the network scales it once more.
  let ys = luma(s.rgb);
  let error = sqrt(max(y2 - ys * ys, 0.0) / (ns + 1e-3) + 1e-10);
  let ramp = 1.0 - exp(-ns / ${float(weights.gateFrames)});
  let keep = ramp * (1.0 - clamp(${float(weights.gamma)} * error, 0.0, 1.0)) * trust.w;
  var out: Output;
  out.accumulated = roundedHalf(s);
  out.denoised = roundedHalf(dn);
  out.aux = roundedHalf(vec4f(y2, ns, nh, slow));
  out.composite = roundedHalf(mix(dn, s, keep));
  return out;
}`;

  // Stabilization: a predicted blend with the previous image inside the
  // range of the current neighbourhood.
  const stabilize = /* wgsl */ `${PARAMS}${TAPS}
@group(0) @binding(2) var depthFixed: texture_2d<f32>;
@group(0) @binding(3) var compositeTexture: texture_2d<f32>;
@group(0) @binding(4) var auxTexture: texture_2d<f32>;
@group(0) @binding(5) var trustHalf: texture_2d<f32>;
@group(0) @binding(6) var previousOutput: texture_2d<f32>;
${following(7)}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = vec2i(position.xy);
  let current = textureLoad(compositeTexture, p, 0);
  if (P.stabilize < 0.5 || P.historyValid < 0.5) { return roundedHalf(current); }
  var low = current;
  var high = current;
  for (var j = 0; j < 9; j++) {
    if (j == 4) { continue; }
    let c = textureLoad(compositeTexture, bounded(p + TAPS[j]), 0);
    low = min(low, c);
    high = max(high, c);
  }
  let h = followed(reproject(position.xy, textureLoad(depthFixed, p, 0).r), position.xy);
  let tolerance = 0.5 * (high - low) + ${float(weights.stabilizeSlack)};
  let clamped = clamp(catmullRom(previousOutput, h.uv), current - tolerance, current + tolerance);
  // The predicted blend is void where this pixel has no usable history.
  let blend = textureSampleLevel(trustHalf, linearSampler, position.xy * P.invSize, 0.0).z *
    step(0.5, textureLoad(auxTexture, p, 0).y);
  return roundedHalf(mix(current, clamped, ${float(weights.stabilizeBlend)} * blend));
}`;

  // Motion from the images alone, for a model that follows it. Reprojection
  // knows the camera, not what objects do. Per 2x2 block: the shift that best
  // explains the difference between this frame and the previous displayed
  // image moved by the running estimate, from that image's gradients (Lucas
  // and Kanade). The frame is rendered with a sub-pixel jitter and the previous
  // image is not, so that known offset is taken out first. Noise in the frame
  // only enters the right-hand side, where the window averages it.
  //
  // The running estimate is read averaged over the window: motion varies
  // slowly over the image, the noise of one block's estimate does not.
  // `previousFlow` is the estimate (x, y), the share it explains and how far
  // to follow it, as the last frame left them; `smoothFlow` the same halved
  // down to the window's scale.
  const kept = /* wgsl */ `
// What the last frame left for this block, where the camera says it was.
struct Kept {
  centre: vec2f,
  estimate: vec2f,
  explained: f32,
  follow: f32,
  valid: f32,
  depth: f32,
};
fn keptMotion(p: vec2i) -> Kept {
  var k: Kept;
  k.depth = textureLoad(depthFixed, p * 2, 0).r;
  let h = reproject(vec2f(p * 2) + 0.5, k.depth);
  k.centre = h.uv + 0.5 * P.invSize;
  k.valid = h.valid * step(0.5, P.historyValid);
  let state = textureSampleLevel(previousFlow, linearSampler, k.centre, 0.0) * k.valid;
  k.estimate = textureSampleLevel(smoothFlow, linearSampler, k.centre, 0.0).xy * k.valid;
  k.explained = state.z;
  k.follow = state.w;
  return k;
}`;
  const motion = /* wgsl */ `${PARAMS}
@group(0) @binding(2) var depthFixed: texture_2d<f32>;
@group(0) @binding(3) var levelOne: texture_2d<f32>;
@group(0) @binding(4) var previousOutput: texture_2d<f32>;
@group(0) @binding(5) var previousFlow: texture_2d<f32>;
@group(0) @binding(6) var smoothFlow: texture_2d<f32>;
${kept}
struct Output {
  @location(0) squares: vec4f,
  @location(1) products: vec4f,
};
// Display range: a Splat far brighter than white must not outvote the rest.
fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
  return clamp(textureSampleLevel(previousOutput, linearSampler, uv + vec2f(dx, dy) * P.invSize, 0.0).rgb, vec3f(0.0), vec3f(1.0));
}
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let p = vec2i(position.xy);
  let k = keptMotion(p);
  let uv = k.centre + (P.jitter - k.estimate) * P.invSize;
  let moved = tap(uv, 0.0, 0.0);
  // Gradients per pixel, over the two-pixel spacing of the blocks.
  let gx = (tap(uv, 2.0, 0.0) - tap(uv, -2.0, 0.0)) * 0.25;
  let gy = (tap(uv, 0.0, 2.0) - tap(uv, 0.0, -2.0)) * 0.25;
  let now = clamp(textureLoad(levelOne, p, 0).rgb, vec3f(0.0), vec3f(1.0));
  let gt = now - moved;
  // What the camera alone leaves of the difference.
  let rest = now - tap(k.centre + P.jitter * P.invSize, 0.0, 0.0);
  var out: Output;
  out.squares = vec4f(dot(gx, gx), dot(gx, gy), dot(gy, gy), dot(gx, gt)) * k.valid;
  out.products = vec4f(dot(gy, gt), dot(gt, gt), dot(rest, rest), 0.0) * k.valid;
  return out;
}`;

  // The window those sums are taken over: halved a few times.
  const pool = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var squares: texture_2d<f32>;
@group(0) @binding(2) var products: texture_2d<f32>;
struct Output {
  @location(0) squares: vec4f,
  @location(1) products: vec4f,
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let uv = position.xy / floor(vec2f(textureDimensions(squares)) * 0.5);
  var out: Output;
  out.squares = textureSampleLevel(squares, linearSampler, uv, 0.0);
  out.products = textureSampleLevel(products, linearSampler, uv, 0.0);
  return out;
}`;

  // The least-squares step, and the running estimate it corrects. One frame's
  // shift is noisy, a few tenths of a pixel at random on a still view, so the
  // estimate is a running mean, and whether it is used is not decided here:
  // the network sees it and says how far to follow next frame.
  const solve = /* wgsl */ `${PARAMS}
@group(0) @binding(2) var depthFixed: texture_2d<f32>;
@group(0) @binding(3) var squares: texture_2d<f32>;
@group(0) @binding(4) var products: texture_2d<f32>;
@group(0) @binding(5) var previousFlow: texture_2d<f32>;
@group(0) @binding(6) var smoothFlow: texture_2d<f32>;
${kept}
struct Output {
  @location(0) motion: vec4f,
  @location(1) shift: vec4f,
};
@fragment fn fragment(@builtin(position) position: vec4f) -> Output {
  let k = keptMotion(vec2i(position.xy));
  let uv = position.xy / floor(P.size * 0.5);
  let s = textureSampleLevel(squares, linearSampler, uv, 0.0);
  let t = textureSampleLevel(products, linearSampler, uv, 0.0);
  let a = s.x + ${float(follow?.damping ?? 0)};
  let d = s.z + ${float(follow?.damping ?? 0)};
  let determinant = a * d - s.y * s.y;
  // frame(x) = previous(x - estimate - correction): the correction that
  // removes the difference, held towards no motion. Where the images have no
  // detail the fit says nothing, and without that hold an estimate stays for
  // good: the flat ground a moving object has left would keep its motion.
  let right = vec2f(s.w, t.x) + ${float((follow?.prior ?? 0) * (follow?.damping ?? 0))} * k.estimate;
  let correction = clamp(vec2f(-(d * right.x - s.y * right.y), -(a * right.y - s.y * right.x)) / determinant, vec2f(-2.0), vec2f(2.0));
  // Still content: the estimate removes nothing of what the camera leaves.
  // Moving content it has locked onto: a good part of it. Where the camera
  // leaves next to nothing, there is nothing to explain.
  let share = clamp((t.z - t.y) / max(t.z, 1e-5), 0.0, 1.0);
  let estimate = k.estimate + ${float(follow?.rate ?? 0)} * correction;
  // The network gave a probability that following is right. Half way is
  // right nowhere, so the estimate is followed fully or not at all, with a
  // short ramp between. Two things switch it off whatever the probability.
  // An estimate that has not been removing a real share of the difference
  // the camera leaves: on a still view that share stays near zero while the
  // estimate itself wanders by a pixel or more. And a block where nothing
  // has a depth: the estimate is taken over a window, so it reaches past the
  // edge of whatever moves, and lines drawn over an empty background beside
  // a turning model would be carried along with it.
  let followed = smoothstep(${float(follow?.threshold[0] ?? 0)}, ${float(follow?.threshold[1] ?? 1)}, k.follow) *
    smoothstep(${float(follow?.explained[0] ?? 0)}, ${float(follow?.explained[1] ?? 1)}, k.explained) *
    step(k.depth, 0.999 * P.far);
  var out: Output;
  out.motion = roundedHalf(vec4f(estimate, k.explained + ${float(follow?.shareRate ?? 0)} * (share - k.explained), k.follow));
  // The shift history is read at, and this frame's correction beside it.
  out.shift = vec4f(estimate * followed, correction);
  return out;
}`;

  // Draws a value three quarters of the way between two halves; which one is
  // stored tells how the GPU rounds.
  const rounding = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var<uniform> value: vec4f;
@fragment fn fragment() -> @location(0) vec4f { return value; }`;

  return {
    depth,
    encode,
    downsample,
    reproject,
    features,
    stage,
    blocks,
    predict,
    update,
    stabilize,
    rounding,
    lowLevel,
    groups: groups.length,
    // Only a model that follows motion runs these.
    follow: follow ? { motion, pool, solve, pools: follow.pools } : null,
  };
}
