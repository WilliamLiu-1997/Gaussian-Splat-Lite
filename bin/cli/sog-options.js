import { parseArgs } from "node:util";
import {
  DEFAULT_CHUNK_SPLATS_K,
  DEFAULT_LOD_DENSITY,
  DEFAULT_LOD_FACTOR,
  DEFAULT_MEMORY_GIB,
  DEFAULT_REGION_SPLATS_K,
  DEFAULT_ROOT_SPLATS_K,
} from "../sog/lod-config.js";
import { configure, defaults } from "../sog/options.js";

export const help = `Build streamed SOG v3 from PLY or SPZ with levels of detail (LOD).

Usage: gsl-build-sog <input> [more inputs...] [options]
       npm run build-sog -- <input> [more inputs...] [options]

Output: lod-meta.json and chunks/ inside <input-stem>-sog/. Existing output is not overwritten.

Options:
  --lod-chunk-count <K>  Maximum splats per output chunk, subject to memory budget (default: ${DEFAULT_CHUNK_SPLATS_K})
  --region-splats <K>    Maximum splats per region, summed across all LODs (default: ${DEFAULT_REGION_SPLATS_K})
  --root-splats <K>      Maximum total splats in the coarsest scene LOD (default: ${DEFAULT_ROOT_SPLATS_K})
  --lod-factor <n>       Divide point count by this factor at each LOD (default: ${DEFAULT_LOD_FACTOR}, >1)
  --lod-density <0..1>   Lower values favor merging smaller splats. Higher values
                        favor preserving relative density (default: ${DEFAULT_LOD_DENSITY})
  --max-sh <0..4>        Maximum SH degree (default: 4)
  --within-dist <x,y,z,radius>
                        Keep splat centers within this sphere (input coordinates)
  --sh-codebook <K>      Maximum SH entries per chunk, 1..256 K (default: automatic)
  --sh-iterations <n>    Color refinement iterations (default: 10)
  --sog-blind <fields>   PLY columns as Blind data; repeat for each four-byte texture
                        column[:type],...; types: u8/u16/u24/u32/f16/f32/unorm8/unorm16
                        Default: smallest unsigned integer; unorm supports [min,max]
  --memory-budget <GiB>  Target memory (default: ${DEFAULT_MEMORY_GIB}, minimum: 1)
  --temp-dir <path>      Temporary working files (default: system temp)
  -o, --output <path>    Output directory (one input only)
  -h, --help             Show this help

K values are positive integers; 1 K = 1024 splats or codebook entries.
Automatic SH codebooks use one entry per 8 splats in each chunk, rounded up,
up to 256 K entries.
PLY input must be uncompressed binary little-endian; SPZ is also supported.
Supports up to SH4. Conversion is lossy; linear opacity above 1.5625 is clamped
with scale compensation and reported. The memory budget is a target, not a hard
memory limit.
Requires Node.js 22.12 or later. No GPU is required.`;

export function parse(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [
          key,
          { type: "string", default: value },
        ]),
      ),
      "within-dist": { type: "string" },
      "sh-codebook": { type: "string" },
      "sog-blind": { type: "string", multiple: true },
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
  return configure(values, positionals);
}
