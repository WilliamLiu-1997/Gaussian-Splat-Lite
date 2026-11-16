# Building streamed SOG files

[Back to documentation](../README.md#documentation)

Convert PLY or SPZ models into streamed SOG v3 with levels of detail (LOD), ready for [SOG streaming](SogStreamScheduler.md). Requires Node.js 22.12 or later. No GPU or compilation is required.

```sh
npm install --global gaussian-splat-lite
gsl-build-sog scene.ply
```

This writes `scene-sog/lod-meta.json` and `scene-sog/chunks/` beside the input.

To run without a global installation:

```sh
npx --package gaussian-splat-lite gsl-build-sog scene.ply
```

From a repository checkout, follow the [development setup](../CONTRIBUTING.md#development-setup), run `npm run build:wasm:lod` (requires Rust), then use `npm run build-sog -- <input>` with the same options.

## Inputs and output

Multiple inputs produce separate outputs. `--output` accepts one input only. Invalid and fully transparent splats are removed and reported.

```sh
# Convert each input to its own output.
gsl-build-sog room.ply garden.spz

# Choose an output directory.
gsl-build-sog scene.ply -o output
```

The output directory is created if needed. Existing `lod-meta.json` and `chunks/` are never overwritten. Failed conversions return a nonzero exit code and clean up unfinished output.

Use `--within-dist x,y,z,radius` to keep splat centers inside or on a sphere in input coordinates, before building LODs. The radius must be nonnegative; removed splats are reported separately.

```sh
gsl-build-sog scene.ply --within-dist 0,0,0,100
```

## Detail levels

```sh
gsl-build-sog scene.ply \
  --lod-chunk-count 256 \
  --region-splats 8 \
  --root-splats 256 \
  --lod-factor 2
```

Count options take positive integers in **K (1 K = 1024)**.

The finest LOD retains the usable input splats. Each coarser level reduces the point count by approximately `--lod-factor`, until the whole scene fits within `--root-splats`. An input already within this limit needs no additional LOD. Smaller factors produce more levels and usually larger output; larger factors produce fewer levels.

`--region-splats` limits the count across all LODs in each spatial region. `--lod-chunk-count` limits output chunk size; chunks may be smaller to fit the memory budget or encoder limits. If a region cannot fit, reduce `--region-splats` or increase `--lod-chunk-count` as suggested by the error.

## SH codebook

The output keeps up to SH4; coefficients above `--max-sh` are discarded. Use `--max-sh 0` to keep only the base color.

Each chunk with higher-order SH has its own codebook. By default, it uses one entry per 8 splats, rounded up, with at most 256K entries. A full 256K-splat chunk uses 32K entries. Set `--sh-codebook <K>` to an integer from 1 to 256, capped at the chunk's splat count. SOG requires a codebook for higher-order SH, so `--sh-codebook 0` is not supported.

```sh
# Use up to 64K entries per chunk and 20 refinement iterations.
gsl-build-sog scene.ply --sh-codebook 64 --sh-iterations 20
```

Larger codebooks can preserve more view-dependent color at the cost of file size. More refinement iterations can improve matching but take longer (default `10`, set with `--sh-iterations <n>`).

Chunks whose SH coefficients are all zero use a single SH entry.

Conversion is lossy, so colors and shape can differ from the source. SOG v3 limits linear opacity to **1.5625**; larger values are clamped, with splat scales increased to compensate, and reported.

## Blind data and PLY comments

Use `--sog-blind` to include custom PLY fields such as object IDs. Repeat the option to include more fields.

```sh
gsl-build-sog scene.ply \
  --sog-blind object_id \
  --sog-blind confidence:f32
```

Fields use `name[:type]`. Omit the type for unsigned integers, or use `f16` or `f32` for decimal values. See `--help` for all supported types. Blind data is disabled by default and supports PLY input only.

Separate fields with commas to pack them into one texture; their encodings must fit in four bytes per `--sog-blind` option. Only retained splats are validated. For automatic types, each group must fit using its fields' maximum values across all retained splats. Automatic integer encodings are chosen separately for each output chunk, so a field's type can differ between chunks. Coarser LODs inherit Blind values from the selected representative splat; values are not averaged.

For `unorm8` and `unorm16`, an optional `[min,max]` range defaults to `[0,1]`; bounds must be finite and increasing. Float32 rounding at the endpoints is accepted and clamped; other out-of-range values are rejected. Values stored as `f16` are rounded to half precision and may overflow to infinity. Quote arguments containing brackets or spaces, for example `--sog-blind 'confidence:unorm8, depth:unorm16[0,100]'`.

PLY comments are preserved automatically.

## Memory and temporary storage

```sh
gsl-build-sog scene.ply --memory-budget 16 --temp-dir /fast-disk/sog-temp
```

`--memory-budget` sets a target in GiB (default `4`, minimum `1`; fractional values accepted). Lower targets can slow conversion and require more temporary disk space; output size and quality may also vary. Leave room for the operating system and other applications.

`--temp-dir` defaults to the system temporary directory. Use a fast disk with enough free space: temporary files can be much larger than the input. They are removed when conversion finishes or fails; cleanup failures report their paths.

## Hosting and loading

Host `lod-meta.json` and `chunks/` together in the output directory. Load `lod-meta.json`:

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler();
await streaming.addSource({ url: "/models/scene-sog/lod-meta.json" });
```

See [SOG streaming](SogStreamScheduler.md) for loading and display options.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--lod-chunk-count <K>` | `256` | Maximum splats per output chunk in K, subject to the memory budget and encoder limits. |
| `--region-splats <K>` | `8` | Maximum count across all LODs in each region, in K. |
| `--root-splats <K>` | `256` | Maximum count in the coarsest scene LOD, in K. |
| `--lod-factor <n>` | `2` | Point-count reduction factor, greater than 1. |
| `--max-sh <0..4>` | `4` | Highest SH degree to keep, limited by the input. |
| `--within-dist <x,y,z,radius>` | Disabled | Keep splat centers inside or on a sphere in input coordinates. |
| `--sh-codebook <K>` | Automatic | Maximum SH entries per chunk, 1–256 K. |
| `--sh-iterations <n>` | `10` | SH codebook refinement iterations; nonnegative. |
| `--sog-blind <fields>` | Disabled | Include custom PLY fields as Blind data; repeatable. |
| `--memory-budget <GiB>` | `4` | Memory target, at least 1 GiB; fractional values accepted. |
| `--temp-dir <path>` | System temp directory | Directory for temporary working files. |
| `-o, --output <path>` | `<input-stem>-sog/` | Output directory, for one input only. |
| `-h, --help` | — | Show command help. |
