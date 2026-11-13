import { parseArgs } from "node:util";
import { GIB } from "../rad/storage.js";

export const help = `Build streamed SOG v3 from PLY or SPZ with levels of detail (LOD).

Usage: gsl-build-sog <input> [more inputs...] [options]
       npm run build-sog -- <input> [more inputs...] [options]

Output: lod-meta.json and chunks/ inside <input-stem>-sog/. Existing output is not overwritten.

Options:
  --lod-chunk-count <K>  Maximum splats per output chunk, subject to memory budget (default: 256)
  --region-splats <K>    Maximum splats per region, summed across all LODs (default: 8)
  --root-splats <K>      Maximum total splats in the coarsest scene LOD (default: 256)
  --lod-factor <n>       Divide point count by this factor at each LOD (default: 2, >1)
  --max-sh <0..4>        Maximum SH degree (default: 4)
  --within-dist <x,y,z,radius>
                        Keep splat centers within this sphere (input coordinates)
  --sh-codebook <K>      Maximum SH entries per chunk, 1..256 K (default: automatic)
  --sh-iterations <n>    Color refinement iterations (default: 10)
  --memory-budget <GiB>  Target memory (default: 4, minimum: 1)
  --temp-dir <path>      Temporary working files (default: system temp)
  -o, --output <path>    Output directory (one input only)
  -h, --help             Show this help

K values are positive integers; 1 K = 1024 splats or codebook entries.
Automatic SH codebooks use one entry per 8 splats in each chunk, rounded up,
up to 256 K entries.
PLY input must be uncompressed binary little-endian; SPZ is also supported.
Supports up to SH4. Conversion is lossy; linear opacity above 1.5625 is clamped
and reported. The memory budget is a target, not a hard memory limit.
Requires Node.js 22.12 or later. No GPU is required.`;

export function parse(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "lod-chunk-count": { type: "string", default: "256" },
      "region-splats": { type: "string", default: "8" },
      "root-splats": { type: "string", default: "256" },
      "lod-factor": { type: "string", default: "2" },
      "max-sh": { type: "string", default: "4" },
      "within-dist": { type: "string" },
      "sh-codebook": { type: "string" },
      "sh-iterations": { type: "string", default: "10" },
      "memory-budget": { type: "string", default: "4" },
      "temp-dir": { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return;
  if (!positionals.length)
    throw new Error("Supply at least one PLY or SPZ input (see --help)");
  if (values.output && positionals.length !== 1)
    throw new Error("--output requires exactly one input");
  let withinDist;
  if (values["within-dist"] !== undefined) {
    withinDist = values["within-dist"]
      .split(",")
      .map((value) => (value.trim() ? Number(value) : Number.NaN));
    if (
      withinDist.length !== 4 ||
      !withinDist.every(Number.isFinite) ||
      withinDist[3] < 0
    )
      throw new Error(
        "--within-dist must be x,y,z,radius with finite numbers and a nonnegative radius",
      );
  }
  const integer = (name, min, max = 0xffffffff) => {
    const value = Number(values[name]);
    if (
      !values[name].trim() ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(`--${name} must be an integer in ${min}..${max}`);
    return value;
  };
  const countInK = (name, max = 0xffffffff) =>
    integer(name, 1, Math.floor(max / 1024)) * 1024;
  const factor = Number(values["lod-factor"]);
  const budget = Number(values["memory-budget"]);
  if (!Number.isFinite(factor) || factor <= 1)
    throw new Error("--lod-factor must be finite and greater than 1");
  if (
    !Number.isFinite(budget) ||
    budget < 1 ||
    !Number.isSafeInteger(Math.floor(budget * GIB))
  )
    throw new Error("--memory-budget must be a finite GiB value of at least 1");
  return {
    inputs: positionals,
    output: values.output,
    tempDir: values["temp-dir"],
    lodChunkCount: countInK("lod-chunk-count"),
    regionSplats: countInK("region-splats"),
    rootSplats: countInK("root-splats"),
    lodFactor: factor,
    maxSh: integer("max-sh", 0, 4),
    withinDist,
    shCodebook:
      values["sh-codebook"] === undefined
        ? undefined
        : countInK("sh-codebook", 262144),
    shIterations: integer("sh-iterations", 0, Number.MAX_SAFE_INTEGER),
    budget: budget * GIB,
  };
}
