import { writeFile } from "node:fs/promises";

// Ulichney's void-and-cluster method:
// https://cv.ulichney.com/papers/1993-void-cluster.pdf
// Run: node scripts/generate-blue-noise.js
const SIZE = 32;
const COUNT = SIZE * SIZE;
const SIGMA = 1.1;
const BROAD_SIGMA = 2.8;
const BROAD_WEIGHT = 2;
const INITIAL_COUNT = Math.floor(COUNT * 0.1);
let seed = 0x47534c;

function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

// Toroidal distances keep the distribution uniform across tile boundaries.
// Two Gaussian scales control local clustering and broader density variation.
const kernel = new Float64Array(COUNT);
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

const occupied = new Uint8Array(COUNT);
const density = new Float64Array(COUNT);

function setPixel(index, value) {
  const delta = value - occupied[index];
  occupied[index] = value;
  const px = index % SIZE;
  const py = Math.floor(index / SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = ((y - py + SIZE) % SIZE) * SIZE;
    for (let x = 0; x < SIZE; x++) {
      density[y * SIZE + x] += delta * kernel[row + ((x - px + SIZE) % SIZE)];
    }
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

// Each rank 0–1023 occurs once; preserve the renderer's uint16 LE format.
const output = Buffer.alloc(COUNT * 2);
for (let i = 0; i < COUNT; i++) output.writeUInt16LE(ranks[i], i * 2);
await writeFile(
  new URL("../src/rendering/blueNoise32.bin", import.meta.url),
  output,
);
console.log(`Generated ${SIZE}×${SIZE} blue noise (${output.length} bytes).`);
