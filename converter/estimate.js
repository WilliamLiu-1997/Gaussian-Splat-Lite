import { MAX_CHUNK_SPLATS, webpBytes } from "../bin/sog/image-limits.js";
import { nextLodCount } from "../bin/sog/lod-config.js";
import { QUANTIZE_BYTES } from "../bin/sog/quantize.js";
import { MAX_WRITERS, PAGE_BYTES, SEGMENT_BYTES } from "./runtime/pages.js";

const MIB = 1024 ** 2;

// Paged columns can acquire disk slots while other phases reserve RAM. A slot
// survives a read back into cache and the physical segments survive until cleanup.
function resources(budget, cores) {
  const base = 128 * MIB;
  const cache = budget - base - 128 * MIB; // Growth and writeback margins.
  return {
    memory: 0,
    spill: 0,
    scratchPeak: 0,
    phase(pages, buffers, revisited = 0, writers = MAX_WRITERS) {
      this.memory = Math.max(
        this.memory,
        Math.min(budget, base + pages + buffers),
      );
      const excess = pages - Math.max(0, cache - buffers);
      if (excess <= 0) return;
      // Estimate how many resident pages already have disk slots using
      // the evicted share of this phase's working set.
      const backed = Math.min(revisited, pages - excess) * (excess / pages);
      const spill = Math.ceil((excess + backed) / PAGE_BYTES) * PAGE_BYTES;
      this.spill = Math.max(this.spill, spill);
      const copies = Math.min(this.spill, writers * SEGMENT_BYTES);
      this.scratchPeak = Math.max(this.scratchPeak, this.spill + copies);
    },
    // The clustering scheduler can use every other core, leaving one arena
    // and a 64 MiB streaming allowance. Each browser worker costs 32 MiB.
    parallel(jobBytes, jobs, shared = 0) {
      const worker = 32 * MIB + jobBytes;
      const room = Math.max(0, cache - 80 * MIB - shared);
      const workers = Math.min(cores - 1, jobs, Math.floor(room / worker));
      return shared + (workers ? workers * worker : jobBytes);
    },
    lod(count) {
      const workers =
        count < 65536
          ? 0
          : Math.min(cores - 1, Math.floor((budget * 0.15) / (35 * MIB)));
      return 64 * MIB + workers * 35 * MIB;
    },
  };
}

// Gathered rows, geometry scratch, the WebP heap (15x RGBA) and the SH
// codebook values, sums and search layouts for one chunk encoder.
function sogEncoder(count, dims, stride, codebook) {
  const entries = dims
    ? Math.min(count, 262144, codebook ?? Math.ceil(count / 8))
    : 0;
  const palette = (entries * dims) / 3;
  const webp = webpBytes(4 * Math.max(count, palette));
  // The encoder holds both RGBA images, its histogram and an output write.
  // Clustering also keeps three 4096-row jobs alongside the codebook.
  const images = 4 * (count + palette) + QUANTIZE_BYTES + MIB;
  const jobs = entries > 0 && entries < count ? 3 * 4096 * (dims * 4 + 20) : 0;
  return (
    count * (stride + 44) +
    webp +
    images +
    jobs +
    entries * dims * (entries < count ? 32 : 4)
  );
}

function sog(count, dims, options, plan) {
  const { rootSplats, lodFactor, regionSplats, lodChunkCount, blind } = options;
  const stride = 76 + dims * 2 + blind.flat().length * 4;
  let chunk = Math.min(count, lodChunkCount, MAX_CHUNK_SPLATS);
  let encoder = sogEncoder(chunk, dims, stride, options.shCodebook);
  // The real planner packs whole regions up to both the chunk and RAM limits.
  const room = options.budget - 272 * MIB;
  if (encoder > room) {
    chunk = Math.max(1, Math.floor((chunk * room) / encoder));
    encoder = sogEncoder(chunk, dims, stride, options.shCodebook);
  }
  let levels = 0;
  let rows = 0;
  let chunks = 0;
  let codes = 0;
  for (let n = count; ; n = nextLodCount(n, lodFactor)) {
    // A factor very close to one can request billions of single-row reductions.
    if (++levels > 1024)
      throw new Error(
        "Too many detail levels to estimate. Increase the LOD reduction factor.",
      );
    rows += n;
    const parts = Math.ceil(n / chunk);
    chunks += parts;
    if (dims)
      codes += Math.min(
        n,
        parts *
          Math.min(262144, options.shCodebook ?? Math.ceil(n / parts / 8)),
      );
    if (n <= rootSplats) break;
  }

  // Geometry averages about 12 compressed bytes per row in the bundled
  // JunkShop scene. SH adds labels and byte-quantized codebook coefficients.
  const regions = Math.ceil(rows / regionSplats);
  const output =
    rows * (12 + 4 * blind.length + (dims ? 2 : 0)) +
    codes * dims +
    chunks * (dims ? 15 : 10) * 1024 +
    regions * (128 + 48 * levels);
  // Partitioning holds the level columns, row order and centers. While merging,
  // the input coexists with the binary tree, grid, ranks and optional blends.
  const tree =
    levels > 1 ? count * (stride + 256 + (dims || blind.length ? 16 : 0)) : 0;
  if (tree) plan.phase(tree, plan.lod(count), count * 64);
  const splitRows = Math.min(
    rows,
    Math.max(regionSplats, Math.floor(options.budget / 2 / 20)),
  );
  const splitJobs = Math.ceil(splitRows / regionSplats);
  plan.phase(
    rows * (stride + (rows > splitRows ? 24 : 4)),
    plan.parallel(
      32 * MIB + Math.min(splitRows, regionSplats) * 28,
      splitJobs,
      splitRows * 20,
    ),
  );
  // Ordering temporarily holds the source and destination geometry column.
  const ordered = rows * (stride - 12);
  plan.phase(ordered + count * 64 + rows * 8, plan.lod(rows), count * 64);

  plan.phase(
    ordered,
    chunks > 1 ? plan.parallel(encoder, chunks) : encoder,
    0,
    1,
  );
  const files = chunks * (6 + blind.length + (dims ? 2 : 0)) + 1;
  return { levels, output, files };
}

function rad(count, dims, options, plan, degree) {
  // The merge tree has 2N-1 nodes. The proportion of parents kept for
  // output depends on geometry; base 1.75 typically keeps about 43%.
  const rows = count + Math.ceil((count - 1) / options.lodBase ** 1.5);
  const chunks = Math.ceil(rows / 65536);
  const codes = dims
    ? Math.min(rows, 262144, options.shCodebook ?? Math.ceil(rows / 8))
    : 0;
  const sh = codes
    ? codes * dims + rows * (codes <= 65536 ? 2 : 4)
    : rows * dims * 0.7;
  const output =
    rows * 18 + sh + chunks * (2 * 1024 + (options.chunked ? 64 : 0));
  const columns = rows * (76 + 2 * dims);
  const lodBuffers = plan.lod(count);
  plan.phase(count * (256 + 2 * dims), lodBuffers, count * 64);
  // Chunk ordering keeps the full tree's records and shapes while gathering
  // retained shapes. SH blending later works on one full tree band at a time.
  const nodes = 2 * count - 1;
  const shapes = nodes * (64 + 28) + rows * (28 + 12) + count * dims * 2;
  const largestBand = dims ? 3 * (2 * degree + 1) : 0;
  plan.phase(
    Math.max(shapes, columns + nodes * largestBand * 2),
    lodBuffers,
    rows * 28,
  );
  if (codes && codes < rows) {
    const samples = Math.min(rows, Math.max(64 * codes, Math.round(rows / 10)));
    const sampled = samples < rows ? samples * (2 * dims + 8) : 0;
    const labels = rows * (codes <= 65536 ? 2 : 4);
    const picks = codes >= 4096 ? samples * 8 : 0;
    // RAD trains one scene-wide codebook. Every search worker needs its
    // own kernel layout; the coordinator holds codes, sums and group tables.
    const tables = codes * (dims + 1);
    const search = tables * 4 + 4096 * (dims * 12 + 128) + MIB;
    plan.phase(
      columns + sampled + labels + picks,
      plan.parallel(search, Math.ceil(samples / 4096), tables * 26),
      samples * dims * 2,
      1, // Training rereads SH and writes labels and group picks in batches.
    );
  } else if (codes) plan.phase(columns + rows * 4, codes * dims * 4, 0, 1);
  // RAD encoders use at most a quarter of the budget for worker jobs.
  const label = codes ? (codes <= 65536 ? 2 : 4) : dims;
  const encoding = Math.min(rows, 65536) * (180 + 4 * label);
  const encoders = Math.max(
    encoding,
    Math.min(chunks * (32 * MIB + encoding), options.budget / 4),
  );
  plan.phase(
    rows * (76 + (codes ? label : 2 * dims)),
    encoders + codes * dims * 8,
    0,
    1,
  );
  const files = options.chunked ? chunks + 1 : 1;
  return { output, files };
}

export function estimateBatch(sources, format, options, cores) {
  let disk = 0;
  let memory = 0;
  let output = 0;
  let saved = 0;
  let minLevels = Number.POSITIVE_INFINITY;
  let maxLevels = 0;
  for (const { count, degree } of sources) {
    const kept = Math.min(degree, options.maxSh);
    const dims = 3 * kept * (kept + 2);
    const plan = resources(options.budget, cores);
    const scene =
      format === "sog"
        ? sog(count, dims, options, plan)
        : rad(count, dims, options, plan, kept);
    // Scratch segments persist until file cleanup. Encoding streams columns
    // in order; allow for one open segment copy alongside the finished scene.
    const tail = Math.min(plan.spill, SEGMENT_BYTES);
    const savedScene = scene.output + scene.files * 4096;
    const outputPeak = plan.spill + tail + savedScene;
    disk = Math.max(disk, saved + Math.max(plan.scratchPeak, outputPeak));
    saved += savedScene;
    output += scene.output;
    memory = Math.max(memory, plan.memory);
    if (format === "sog") {
      minLevels = Math.min(minLevels, scene.levels);
      maxLevels = Math.max(maxLevels, scene.levels);
    }
  }
  const levels =
    format === "rad"
      ? "Adaptive"
      : minLevels === maxLevels
        ? String(maxLevels)
        : `${minLevels}–${maxLevels}`;
  return { levels, disk, memory, output };
}
