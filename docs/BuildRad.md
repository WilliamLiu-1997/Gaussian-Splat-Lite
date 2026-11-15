# Building RAD files

[Back to documentation](../README.md#documentation)

Convert PLY or SPZ models into RAD files with levels of detail (LOD), ready for [RAD streaming](RadStreamScheduler.md). Requires Node.js 22.12 or later. No GPU or compilation is required.

```sh
npm install --global gaussian-splat-lite
gsl-build-rad scene.ply
```

This writes `scene-lod.rad` beside the input.

To run without a global installation:

```sh
npx --package gaussian-splat-lite gsl-build-rad scene.ply
```

From a repository checkout, follow the [development setup](../CONTRIBUTING.md#development-setup), run `npm run build:wasm:lod` (requires Rust), then use `npm run build-rad -- <input>` with the same options.

## Inputs and output

Multiple inputs produce separate outputs. `--output` accepts one input only. Invalid and fully transparent splats are removed and reported.

```sh
# Convert each input to its own output.
gsl-build-rad room.ply garden.spz

# Choose an output file.
gsl-build-rad scene.ply -o output/scene.rad
```

The output directory must exist. Existing output files are never overwritten. Failed conversions return a nonzero exit code and clean up unfinished output.

Use `--within-dist x,y,z,radius` to keep splat centers inside or on a sphere in input coordinates, before building LODs. The radius must be nonnegative; removed splats are reported separately.

```sh
gsl-build-rad scene.ply --within-dist 0,0,0,100
```

## Detail levels

```sh
gsl-build-rad scene.ply --lod-base 1.75
```

`--lod-base` controls the spacing between detail levels (default `1.75`, range `1.1`–`16`). Smaller values produce more levels and usually larger output; larger values produce fewer levels. Usable input splats are retained.

## SH codebook

The output keeps up to SH3. SH4 inputs are accepted; coefficients above `--max-sh` are discarded. Use `--max-sh 0` to keep only the base color.

By default, one shared SH codebook covers the completed LOD tree. It uses one entry per 8 splats, rounded up, with at most 256K entries. Set `--sh-codebook <K>` to an integer from 1 to 256 (1 K = 1024 entries), capped at the tree's splat count. Use `--sh-codebook 0` to store SH without a codebook.

```sh
# Use up to 64K entries and 20 refinement iterations.
gsl-build-rad scene.ply --sh-codebook 64 --cluster-sh=20

# Store SH coefficients without a codebook.
gsl-build-rad scene.ply --sh-codebook 0
```

Larger codebooks can preserve more view-dependent color at the cost of file size. More refinement iterations can improve matching but take longer (default `10`, set with `--cluster-sh=<n>`).

Conversion is lossy, so colors and shape can differ from the source. Codebooks can reduce file size, but small models may grow. Models without higher-order SH are written without a codebook.

## Memory and temporary storage

```sh
gsl-build-rad scene.ply --memory-budget 16 --temp-dir /fast-disk/rad-temp
```

`--memory-budget` sets a target in GiB (default `4`, minimum `1`; fractional values accepted). Lower targets can slow conversion and require more temporary disk space; output quality is unchanged. Leave room for the operating system and other applications.

`--temp-dir` defaults to the system temporary directory. Use a fast disk with enough free space: temporary files can be much larger than the input. They are removed when conversion finishes or fails; cleanup failures report their paths.

## Hosting and loading

```sh
gsl-build-rad scene.ply --rad-chunked
```

`--rad-chunked` writes `scene-lod.rad` plus `scene-lod-0.radc`, `scene-lod-1.radc`, and so on. Host them together and load the `.rad` file. A single `.rad` file also supports streaming; its server must support HTTP Range requests.

```js
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler();
await streaming.addSource({ url: "/models/scene-lod.rad" });
```

See [RAD streaming](RadStreamScheduler.md) for loading and display options.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--lod-base <base>` | `1.75` | LOD spacing, from `1.1` to `16`. |
| `--max-sh <0..3>` | `3` | Highest SH degree to keep, limited by the input. |
| `--within-dist <x,y,z,radius>` | Disabled | Keep splat centers inside or on a sphere in input coordinates. |
| `--sh-codebook <K>` | Automatic | Maximum SH entries for the LOD tree, 1–256 K; `0` disables the codebook. |
| `--cluster-sh[=<n>]` | `10` | SH codebook refinement iterations; nonnegative. |
| `--memory-budget <GiB>` | `4` | Memory target, at least 1 GiB; fractional values accepted. |
| `--temp-dir <path>` | System temp directory | Directory for temporary working files. |
| `--rad-chunked` | Disabled | Write a header and separate `.radc` files. |
| `-o, --output <path>` | `<input-stem>-lod.rad` | Output file, for one input only. |
| `-h, --help` | — | Show command help. |
