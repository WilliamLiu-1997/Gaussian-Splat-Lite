# Building streamed SOG files

[Back to documentation](../README.md#documentation)

Convert PLY or SPZ into streamed SOG v3 with levels of detail (LOD), ready for [SOG streaming](SogStreamScheduler.md). Requires Node.js 22.12 or later. No GPU is required.

```sh
gsl-build-sog scene.ply -o output --memory-budget 4
```

From a repository checkout, first run `npm run build:wasm:lod` (requires Rust), then use:

```sh
npm run build-sog -- scene.ply -o output
```

`--output` specifies the output directory, containing `lod-meta.json` and `chunks/`. Without it, each input writes to `<input-stem>-sog/` beside the input file. Multiple inputs are accepted and each produces its own scene. PLY must be uncompressed binary little-endian; SPZ is also supported. Invalid and fully transparent splats are removed and reported.

Use `--within-dist x,y,z,radius` to keep only splats whose centers are inside or on a sphere in input coordinates, before building LODs. The radius must be nonnegative; removed splats are reported separately.

```sh
gsl-build-sog scene.ply --within-dist 0,0,0,100 -o output
```

## Detail levels and regions

```sh
gsl-build-sog scene.ply \
  --lod-chunk-count 256 \
  --region-splats 8 \
  --root-splats 256 \
  --lod-factor 2
```

`--lod-chunk-count`, `--region-splats`, `--root-splats` and `--sh-codebook` take positive integers in **K (1 K = 1024)**. For example, `--lod-chunk-count 256` allows up to 262,144 splats per chunk, and `--sh-codebook 64` sets a maximum of 65,536 SH entries per chunk.

The finest LOD retains the usable input splats. Each coarser level reduces the point count by approximately `--lod-factor`, until the whole scene fits within `--root-splats`. An input already within this limit needs no additional LOD. Smaller factors produce more levels and usually larger output; larger factors produce fewer levels.

`--region-splats` limits the count across all LODs in each spatial region, independently of the LOD settings. `--lod-chunk-count` controls output chunk size; chunks may be smaller to fit the memory budget. If a region cannot fit in a chunk, reduce `--region-splats` or increase the chunk or memory limit.

## Color and quality

The output supports up to SH4. Use `--max-sh 0` to keep only the base color and reduce file size. Higher SH levels retain more view-dependent color.

Without `--sh-codebook`, each chunk uses one SH entry per 8 splats, rounded up, with at most 256K entries. A full 256K-splat chunk therefore uses 32K entries. Specify `--sh-codebook <K>` to override this automatic size; the entry count never exceeds the chunk's splat count. Larger codebooks can preserve more color detail at the cost of file size; more `--sh-iterations` can improve color matching but take longer.

Conversion is lossy, so colors and shape can differ from the source. SOG v3 limits linear opacity to **1.5625**; larger values are clamped and reported.

## Memory and output

```sh
gsl-build-sog scene.spz --memory-budget 8 --temp-dir /fast-disk/sog-temp
```

`--memory-budget` sets a target in GiB, not a hard memory limit. Smaller budgets can make conversion slower and require more temporary disk space; output size and quality may also vary. Leave room for the operating system and other applications.

`--temp-dir` chooses where temporary files are stored. Use a fast disk with enough free space, as these files can be much larger than the input. They are removed when conversion finishes or fails; cleanup failures report their paths.

The output directory is created if needed. An existing `lod-meta.json` or `chunks/` is never overwritten. Keep the complete output directory together when hosting or moving a scene, and load its `lod-meta.json`:

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler();
await streaming.addSource({ url: "/models/scene/lod-meta.json" });
```

See [SOG streaming](SogStreamScheduler.md) for loading and display options.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--lod-chunk-count <K>` | `256` | Maximum splats per output chunk in K, subject to the memory budget. |
| `--region-splats <K>` | `8` | Maximum count across all LODs in each region, in K. |
| `--root-splats <K>` | `256` | Maximum count in the coarsest scene LOD, in K. |
| `--lod-factor <n>` | `2` | Point-count reduction factor, greater than 1. |
| `--max-sh <0..4>` | `4` | Highest SH degree retained, limited by the input. |
| `--within-dist <x,y,z,radius>` | Disabled | Keep splat centers inside or on a sphere before building LODs, in input coordinates. |
| `--sh-codebook <K>` | Automatic | One entry per 8 splats, rounded up, up to 256K. Override with 1–256 K. |
| `--sh-iterations <n>` | `10` | Color refinement iterations; nonnegative. |
| `--memory-budget <GiB>` | `4` | Memory target, at least 1 GiB; fractional values accepted. |
| `--temp-dir <path>` | System temp directory | Directory for temporary working files. |
| `-o, --output <path>` | `<input-stem>-sog/` | Output directory, for one input only. |
| `-h, --help` | — | Show command help. |
