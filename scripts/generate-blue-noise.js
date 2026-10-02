import { writeFile } from "node:fs/promises";

// Ulichney's void-and-cluster method:
// https://cv.ulichney.com/papers/1993-void-cluster.pdf
// Spatiotemporal extension: interact within an XY slice or along one pixel's
// time axis, never across both space and time at once.
// https://developer.nvidia.com/blog/rendering-in-real-time-with-spatiotemporal-blue-noise-textures-part-1/
// Filter-adapted temporal energy:
// https://www.ea.com/seed/news/spatio-temporal-sampling
// Run: node scripts/generate-blue-noise.js
const SIZE = 32;
const FRAMES = 32;
const SLICE = SIZE * SIZE;
const COUNT = SLICE * FRAMES;
const SIGMA = 1.1;
const BROAD_SIGMA = 2.8;
const BROAD_WEIGHT = 2;
const CURRENT_FRAME_WEIGHT = 0.05;
const INITIAL_COUNT = Math.floor(COUNT * 0.1);
let seed = 0x47534c;

function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

// Toroidal distances keep the distribution uniform across tile boundaries.
// Two Gaussian scales control local clustering and broader density variation.
const kernel = new Float64Array(SLICE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.min(x, SIZE - x);
    const dy = Math.min(y, SIZE - y);
    const distanceSquared = dx * dx + dy * dy;
    kernel[y * SIZE + x] =
      Math.exp(-distanceSquared / (2 * SIGMA * SIGMA)) +
      BROAD_WEIGHT *
        Math.exp(-distanceSquared / (2 * BROAD_SIGMA * BROAD_SIGMA));
  }
}

// Optimize for TAA's base exponential history weight. Pairwise energy uses
// the filter's autocorrelation, not its taps directly. Wrap the history around
// the 32-frame cycle so every starting/stopping phase is treated equally.
// This models accumulation only, not TAA's nonlinear clipping/rejection.
const temporalKernel = new Float64Array(FRAMES);
const historyWeights = Float64Array.from(
  { length: FRAMES },
  (_, t) =>
    (CURRENT_FRAME_WEIGHT * (1 - CURRENT_FRAME_WEIGHT) ** t) /
    (1 - (1 - CURRENT_FRAME_WEIGHT) ** FRAMES),
);
for (let t = 0; t < FRAMES; t++) {
  for (let j = 0; j < FRAMES; j++) {
    temporalKernel[t] += historyWeights[j] * historyWeights[(j + t) % FRAMES];
  }
}
// Give spatial and temporal density the same total weight.
const temporalScale =
  kernel.reduce((sum, value) => sum + value, 0) /
  temporalKernel.reduce((sum, value) => sum + value, 0);
for (let t = 0; t < FRAMES; t++) temporalKernel[t] *= temporalScale;

const occupied = new Uint8Array(COUNT);
const density = new Float64Array(COUNT);

function setPixel(index, value) {
  const delta = value - occupied[index];
  occupied[index] = value;
  const pixel = index % SLICE;
  const frame = Math.floor(index / SLICE);
  const base = frame * SLICE;
  const px = pixel % SIZE;
  const py = Math.floor(pixel / SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = ((y - py + SIZE) % SIZE) * SIZE;
    for (let x = 0; x < SIZE; x++) {
      density[base + y * SIZE + x] +=
        delta * kernel[row + ((x - px + SIZE) % SIZE)];
    }
  }
  for (let t = 0; t < FRAMES; t++) {
    density[t * SLICE + pixel] +=
      delta * temporalKernel[(t - frame + FRAMES) % FRAMES];
  }
}

function reset(pattern) {
  occupied.fill(0);
  density.fill(0);
  for (let i = 0; i < COUNT; i++) {
    if (pattern[i]) setPixel(i, 1);
  }
}

// An occupied pixel with highest density is the tightest cluster; an empty
// pixel with lowest density is the largest void. Scan order breaks ties.
function findPixel(value) {
  let best = -1;
  let score = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < COUNT; i++) {
    const candidate = value ? density[i] : -density[i];
    if (occupied[i] === value && candidate > score) {
      best = i;
      score = candidate;
    }
  }
  return best;
}

const shuffled = Uint16Array.from({ length: COUNT }, (_, i) => i);
for (let i = COUNT - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
for (let i = 0; i < INITIAL_COUNT; i++) setPixel(shuffled[i], 1);

// Relax the seed pattern until moving a clustered pixel no longer helps.
while (true) {
  const cluster = findPixel(1);
  setPixel(cluster, 0);
  const voidPixel = findPixel(0);
  setPixel(voidPixel, 1);
  if (cluster === voidPixel) break;
}

const initial = occupied.slice();
const ranks = new Uint16Array(COUNT);

// Rank sparse coverage by progressively removing the tightest clusters.
for (let rank = INITIAL_COUNT - 1; rank >= 0; rank--) {
  const pixel = findPixel(1);
  ranks[pixel] = rank;
  setPixel(pixel, 0);
}

// Grow the relaxed pattern by filling its largest voids up to half coverage.
reset(initial);
for (let rank = INITIAL_COUNT; rank < COUNT / 2; rank++) {
  const pixel = findPixel(0);
  ranks[pixel] = rank;
  setPixel(pixel, 1);
}

// Above half coverage, distribute the remaining holes evenly instead.
reset(occupied.map((value) => 1 - value));
for (let rank = COUNT / 2; rank < COUNT; rank++) {
  const pixel = findPixel(1);
  ranks[pixel] = rank;
  setPixel(pixel, 0);
}

// Each rank 0–32767 occurs once. Stack XY slices vertically in a 32×1024
// atlas so WebGL and WebGPU can use the same integer 2D texture lookup.
const output = Buffer.alloc(COUNT * 2);
for (let i = 0; i < COUNT; i++) output.writeUInt16LE(ranks[i], i * 2);
await writeFile(
  new URL("../src/rendering/blueNoise32.bin", import.meta.url),
  output,
);
console.log(
  `Generated ${SIZE}×${SIZE}×${FRAMES} spatiotemporal blue noise (${output.length} bytes).`,
);
