import { configure } from "../rad/options.js";

export const help = `Convert PLY or SPZ files to RAD with levels of detail (LOD).

Usage: gsl-build-rad <input> [more inputs...] [options]
       npm run build-rad -- <input> [more inputs...] [options]

Inputs: PLY, SPZ.
Output: <input-stem>-lod.rad. Existing files are not overwritten.

Options:
  --lod-base <base>      LOD spacing (default: 1.75, range: 1.1..16)
  --max-sh <0..3>        Maximum SH degree (default: 3)
  --within-dist <x,y,z,radius>
                        Keep splat centers within this sphere (input coordinates)
  --cluster-sh[=<n>]     SH codebook refinement iterations (default: 10)
  --sh-codebook <K>      Maximum SH entries, 0..256 K (default: automatic)
                        0 stores SH coefficients without a codebook
  --rad-chunked          Write a .rad header and separate .radc files
  --memory-budget <GiB>  Target memory in GiB (default: 4, minimum: 1)
  --temp-dir <path>      Temporary file location (default: system temp)
  -o, --output <path>    Output .rad path (one input only)
  -h, --help             Show this help

K is a nonnegative integer; 1 K = 1024 codebook entries.
Automatic SH codebooks use one entry per 8 LOD splats, rounded up, at most 256 K.
SH4 inputs are accepted; coefficients above --max-sh are discarded.
The memory target covers the conversion, worker threads and pending disk writes included.
Requires Node.js 22.12 or later. No compilation is required.`;

const valueOptions = new Set([
  "--lod-base",
  "--max-sh",
  "--sh-codebook",
  "--within-dist",
  "--memory-budget",
  "--temp-dir",
  "--output",
  "-o",
]);

export function parse(args) {
  const inputs = [];
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return;
    if (arg === "--") {
      inputs.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--rad-chunked") {
      values["rad-chunked"] = true;
      continue;
    }
    if (arg === "--cluster-sh" || arg.startsWith("--cluster-sh=")) {
      values["cluster-sh"] =
        arg === "--cluster-sh" ? undefined : arg.slice(13).trim() || Number.NaN;
      continue;
    }
    if (!arg.startsWith("-")) {
      inputs.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal < 0 ? arg : arg.slice(0, equal);
    if (!valueOptions.has(name)) throw new Error(`Unknown option: ${arg}`);
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value?.trim()) throw new Error(`${name} requires a value`);
    values[name === "-o" ? "output" : name.slice(2)] = value;
  }
  if (!inputs.length) throw new Error(help);
  if (values.output && inputs.length !== 1)
    throw new Error("--output requires exactly one input");
  return configure(values, inputs);
}
