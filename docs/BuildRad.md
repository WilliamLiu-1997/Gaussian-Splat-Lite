# Building RAD files

[Back to documentation](../README.md#documentation)

Convert PLY or SPZ models into RAD files with levels of detail (LOD), ready for [RAD streaming](RadStreamScheduler.md). Requires Node.js 22.12 or later. No compilation is required.

```sh
npm install --global gaussian-splat-lite
gsl-build-lod scene.ply
```

This writes `scene-lod.rad` beside the input. Large models can take a long time to convert.

To run without a global installation:

```sh
npx --package gaussian-splat-lite gsl-build-lod scene.ply
```

From a repository checkout, first build the decoder with `npm run build:wasm:lod` (requires Rust), then use `npm run build-lod -- <input>` with the same options. The full `npm run build:wasm` command also builds the decoder.

## Inputs and output

Inputs must be `.ply` or `.spz` files. Splats with NaN or infinite values, or a zero rotation, are skipped, and the conversion reports how many.

```sh
# Convert several files, each to its own RAD file.
gsl-build-lod room.ply garden.spz

# Choose an output path for a single input.
gsl-build-lod scene.ply -o output/scene.rad

# Keep only the base color, reducing file size and memory use.
gsl-build-lod scene.ply --max-sh 0
```

The output directory must exist. Existing output files, including matching `.radc` files when using `--rad-chunked`, are never overwritten. Choose a different output name or remove the old files before converting again. Output files are first written under hidden temporary names in the output directory and receive their final names only after all of them are complete. Failed conversions return a nonzero exit code and remove their output files; if a file cannot be removed, a warning shows its path.

The output keeps up to SH3. SH4 inputs are accepted and converted to SH3 or the level chosen with `--max-sh`. Higher SH levels retain more view-dependent color and increase file size. Conversion is lossy, so colors and shape can differ slightly from the source.

## LOD spacing

```sh
gsl-build-lod scene.ply --lod-base 1.75
```

`--lod-base` controls the spacing between detail levels (default `1.75`, range `1.1`–`16`). Smaller values produce more intermediate levels and usually larger files; larger values produce fewer levels and usually smaller files. This setting does not discard input splats.

## SH codebook

```sh
# Use the default SH codebook with 10 refinement iterations.
gsl-build-lod scene.ply

# Change the number of refinement iterations.
gsl-build-lod scene.ply --cluster-sh=20

# Store SH coefficients without a codebook.
gsl-build-lod scene.ply --no-cluster-sh
```

By default, SH coefficients are stored as a shared codebook, and each splat stores the index of its entry. The codebook holds up to 65,536 entries for SH1, 174,763 for SH2, or 327,680 for SH3, based on the SH degree retained after `--max-sh`. It never has more entries than the number of splats after LOD. This can substantially reduce SH data for large models; the savings depend on the splat count and SH values. Models that fit entirely in the codebook still store one entry per splat plus an index for each splat, so the file may grow. Each splat's view-dependent color comes from its nearest entry, so highlights and reflections can lose some detail. Positions, shapes, base colors and LOD are unchanged. Use `--no-cluster-sh` to disable the codebook.

The codebook is refined in 10 iterations by default; `--cluster-sh=<n>` sets another number. Larger codebooks preserve more distinct SH values but increase conversion time and memory use. Clustering runs on as many CPU cores as the memory target leaves room for.

Models without SH, or converted with `--max-sh 0`, are written without a codebook.

## Memory and temporary storage

```sh
gsl-build-lod scene.ply --memory-budget 16 --temp-dir /fast-disk/rad-temp
```

`--memory-budget` sets a target in GiB (default `4`, minimum `1`, fractional values accepted). Values such as `16` are supported when enough RAM is available. Lower targets may make conversion slower and require more temporary disk space; output quality is unchanged. If conversion reports insufficient memory, increase this value.

The target covers the whole conversion, worker threads included: the converter measures its memory as it runs and keeps within it. Leave room for the operating system and other applications.

`--temp-dir` chooses where temporary working files are stored; the default is the system temporary directory. Use a fast disk with enough free space, as temporary files can be much larger than the input. Each conversion keeps them in its own `gsl-build-rad-*` folder there, which is removed when the conversion finishes or fails; if it cannot be removed, a warning shows its path.

## Split files

```sh
gsl-build-lod scene.ply --rad-chunked
```

This writes `scene-lod.rad` plus `scene-lod-0.radc`, `scene-lod-1.radc`, and so on.

Host all files together in the same directory and load the `.rad` file. A single `.rad` file also supports streaming; its server must support HTTP Range requests.

```js
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler({
  url: "/models/scene-lod.rad",
});
```

See [RadStreamScheduler](RadStreamScheduler.md) for the complete loading and display example.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--lod-base <base>` | `1.75` | LOD spacing, from `1.1` to `16`; smaller values retain more detail levels. |
| `--max-sh <0..3>` | `3` | Highest SH degree to keep, limited by the input. |
| `--within-dist <x,y,z,radius>` | Disabled | Keep splat centers inside or on a sphere before building LOD, in input coordinates. |
| `--cluster-sh[=<n>]` | Enabled, `10` iterations | Store SH as a codebook of up to 65,536/174,763/327,680 entries for SH1/SH2/SH3, refined in `n` iterations. See [SH codebook](#sh-codebook). |
| `--no-cluster-sh` | — | Store SH coefficients without a codebook. |
| `--memory-budget <GiB>` | `4` | Target memory use in GiB, at least `1`; for example `16`. |
| `--temp-dir <path>` | System temp directory | Location for temporary files; created if needed. |
| `--rad-chunked` | Disabled | Write a header and separate `.radc` files. |
| `-o <path>` or `--output <path>` | `<input-stem>-lod.rad` | Output path; requires exactly one input. |
| `-h` or `--help` | — | Show command help. |
