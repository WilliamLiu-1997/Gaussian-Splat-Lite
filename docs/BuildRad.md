# Building RAD files

[Back to documentation](../README.md#documentation)

Convert PLY or SPZ models into RAD files with levels of detail (LOD), ready for [RAD streaming](RadStreamScheduler.md). Requires Node.js 22.12 or later. No compilation is required.

```sh
npm install --global gaussian-splat-lite
gsl-build-rad scene.ply
```

This writes `scene-lod.rad` beside the input. Large models can take a long time to convert.

To run without a global installation:

```sh
npx --package gaussian-splat-lite gsl-build-rad scene.ply
```

From a repository checkout, first build the decoder with `npm run build:wasm:lod` (requires Rust), then use `npm run build-rad -- <input>` with the same options. The full `npm run build:wasm` command also builds the decoder.

## Inputs and output

Inputs must be `.ply` or `.spz` files. Splats with NaN or infinite values, or a zero rotation, are skipped, and the conversion reports how many.

```sh
# Convert several files, each to its own RAD file.
gsl-build-rad room.ply garden.spz

# Choose an output path for a single input.
gsl-build-rad scene.ply -o output/scene.rad

# Keep only the base color, reducing file size and memory use.
gsl-build-rad scene.ply --max-sh 0
```

The output directory must exist. Existing output files, including matching `.radc` files when using `--rad-chunked`, are never overwritten. Choose a different output name or remove the old files before converting again. Output files appear only once the whole conversion has succeeded. Failed conversions return a nonzero exit code and leave no output files; if a file cannot be removed, a warning shows its path.

The output keeps up to SH3. SH4 inputs are accepted and converted to SH3 or the level chosen with `--max-sh`. Higher SH levels retain more view-dependent color and increase file size. Conversion is lossy, so colors and shape can differ slightly from the source.

## LOD construction

The default `--lod-mode rad` builds LOD by repeatedly merging similar pairs of splats.

```sh
# Try representative-based merging, keeping a separate output for comparison.
gsl-build-rad scene.ply --lod-mode representative -o scene-representative.rad
```

`--lod-mode representative` is an experimental alternative using the SOG voxel representative method. Large rounds are divided into spatial working blocks that fit the memory budget. Within each block, it selects representatives in uniform cells sized from splat features, assigns splats to representatives in their own or neighboring cells, and merges each group together. Rounds reduce the active splat count by approximately half, repartitioning the results until the whole tree reaches one root. All input splats remain available at full detail, and the output supports the same RAD loaders and streaming.

The two modes can produce different appearances, node counts and conversion times. Compare them at similar displayed splat counts; the same `--lod-base` does not ensure the same display budget. Working blocks limit merging within a round; their results can merge across those boundaries in subsequent rounds.

## LOD spacing

```sh
gsl-build-rad scene.ply --lod-base 1.75
```

`--lod-base` controls the spacing between detail levels (default `1.75`, range `1.1`–`16`). Smaller values produce more intermediate levels and usually larger files; larger values produce fewer levels and usually smaller files. This setting does not discard input splats.

## SH codebook

```sh
# Use the default SH codebook with 10 refinement iterations.
gsl-build-rad scene.ply

# Change the number of refinement iterations.
gsl-build-rad scene.ply --cluster-sh=20

# Store SH coefficients without a codebook.
gsl-build-rad scene.ply --no-cluster-sh
```

By default, splats share their SH coefficients through a codebook of up to 262144 entries per SH level, instead of each storing its own. This can make large models much smaller; small models can grow. View-dependent color becomes approximate, so highlights and reflections can lose some detail. Positions, shapes, base colors and LOD are unchanged. Use `--no-cluster-sh` to disable the codebook.

The codebook is refined in 10 iterations by default; `--cluster-sh=<n>` sets another number. More iterations take longer and can match the original colors more closely.

Models without SH, or converted with `--max-sh 0`, are written without a codebook.

## Memory and temporary storage

```sh
gsl-build-rad scene.ply --memory-budget 16 --temp-dir /fast-disk/rad-temp
```

`--memory-budget` sets a target in GiB (default `4`, minimum `1`, fractional values accepted). Values such as `16` are supported when enough RAM is available. Lower targets may make conversion slower and require more temporary disk space. The default `rad` mode preserves output quality across budgets; `representative` may use smaller working blocks at low budgets, which can change the result. If conversion reports insufficient memory, increase this value.

The target covers the whole conversion. Leave room for the operating system and other applications.

`--temp-dir` chooses where temporary working files are stored; the default is the system temporary directory. Use a fast disk with enough free space, as temporary files can be much larger than the input. Each conversion keeps them in its own `gsl-build-rad-*` folder there, which is removed when the conversion finishes or fails; if it cannot be removed, a warning shows its path.

`ENOSPC` means the drive is full. For a large model on an external drive, set `--temp-dir` to a folder on that drive if it has more free space. The output drive also needs room for the final file; increasing `--memory-budget` does not add disk space.

## Split files

```sh
gsl-build-rad scene.ply --rad-chunked
```

This writes `scene-lod.rad` plus `scene-lod-0.radc`, `scene-lod-1.radc`, and so on.

Host all files together in the same directory and load the `.rad` file. A single `.rad` file also supports streaming; its server must support HTTP Range requests.

```js
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler();
await streaming.addSource({ url: "/models/scene-lod.rad" });
```

See [RadStreamScheduler](RadStreamScheduler.md) for the complete loading and display example.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--lod-mode <mode>` | `rad` | LOD construction: `rad` for similar-pair merging, or experimental `representative` for voxel representative merging. |
| `--lod-base <base>` | `1.75` | LOD spacing, from `1.1` to `16`; smaller values retain more detail levels. |
| `--max-sh <0..3>` | `3` | Highest SH degree to keep, limited by the input. |
| `--within-dist <x,y,z,radius>` | Disabled | Keep splat centers inside or on a sphere before building LOD, in input coordinates. |
| `--cluster-sh[=<n>]` | Enabled, `10` iterations | Store SH in a shared codebook, refined in `n` iterations. See [SH codebook](#sh-codebook). |
| `--no-cluster-sh` | — | Store SH coefficients without a codebook. |
| `--memory-budget <GiB>` | `4` | Target memory use in GiB, at least `1`; for example `16`. |
| `--temp-dir <path>` | System temp directory | Location for temporary files; created if needed. |
| `--rad-chunked` | Disabled | Write a header and separate `.radc` files. |
| `-o <path>` or `--output <path>` | `<input-stem>-lod.rad` | Output path; requires exactly one input. |
| `-h` or `--help` | — | Show command help. |
