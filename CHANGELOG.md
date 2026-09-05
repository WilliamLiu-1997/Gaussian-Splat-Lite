# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added native WebGPU accumulation and Splat rendering through TSL while retaining the existing Worker/WASM CPU sorting pipeline.
- Added a WebGL/WebGPU backend toggle to the bundled viewer for direct comparison.
- Added an optional same-frame sorting mode that uses GPU radix sorting on WebGPU and main-thread WASM sorting on WebGL.
- Added optional stochastic rendering, depth-only drawing, and `StochasticResolvePass`.
- Enabled manual stochastic rendering and per-eye spatial resolve in WebGL/WebGPU XR, while keeping automatic stochastic switching disabled in XR.

### Changed

- Run the development viewer directly from source with Vite and use one cross-platform Node script to build WASM.
- Share PLY batch storage, SH codecs, loading flow, and texture compatibility checks across their callers.
- Organized source files by responsibility and separated WebGL/WebGPU materials, accumulation, ordering resources and readback from shared renderer orchestration, preserving the package API.
- Pinned the Three.js development and peer dependency to the tested GitHub development snapshot `d2fc542d`, keeping the built WebGPU/TSL code and its compatibility patches reproducible.
- Replaced WebGPU accumulator render passes with fixed compute kernels writing GPU-only storage array textures, and packed per-mesh ranges without row padding.
- Restored target-aware sRGB decoding for WebGL and added equivalent working-space decoding for WebGPU before transparent compositing.
- Reuse radix dispatch lists while the workgroup count is unchanged and configure the shared prefix scan once per list, retaining fixed compute nodes through resize.
- Simplified stochastic resolve filtering and configuration changes, and removed redundant XR camera copies and per-draw matrix allocations.

### Fixed

- Preserve finite SH channels when another channel is NaN, using the same encoding rules for `Splats` and `postDecode`.
- Rebuild texture pairs when either Splat buffer changes and detect changes to typed-array view offsets.
- Use per-eye camera-relative transforms for WebGPU XR and per-eye viewport sizes for WebGL/WebGPU XR.
- Clear the manual stochastic state when automatic camera motion takes over, so it cannot enable automatic stochastic rendering in XR.
- Preserve the displayed GPU ordering until the first asynchronous worker result is ready, without transferring or overwriting the sorter's allocation buffers.
- Update WebGPU Splats for each render call, including multiple renders within one animation frame.
- Defer sorter disposal until outstanding GPU precompilation finishes and cancel pending deferred renderer updates on disposal.
- Keep stochastic motion revisions monotonic across resets so an old sort cannot complete a newer settle request.
- Reject radix sort counts outside allocated buffer capacity.

## [0.1.16] - 2026-09-03

### Changed

- Increased the default `SplatMesh.minRaycastOpacity` from `0.05` to `0.1`.
- Accepted only the ellipsoid entry intersection, so rays starting inside a Splat or entering before the near plane no longer select its exit surface.

### Fixed

- Updated scene world matrices before Splat renderer updates read camera, mesh, and edit transforms, including explicit `update()` calls made before rendering.

## [0.1.15] - 2026-09-01

### Changed

- Switched the default Splat material to front-face culling with matching quad winding.
- Raycast thin nonzero Splats as ellipsoids, reserving flat-disk intersection for an exact zero scale axis.

### Removed

- Removed the optional 2DGS rendering path and the `GaussianSplatRenderer.enable2DGS` option.

## [0.1.14] - 2026-08-31

### Added

- Added hover details to the Viewer JavaScript heap statistic.

### Changed

- Restored the default `GaussianSplatRenderer.minAlpha` to `0.5 / 255` to reduce visible Gaussian cutoff boundaries.

## [0.1.13] - 2026-08-31

### Added

- Added `tan`, `asin`, `atan`, and vector-aware `atan2(y, x)` operations to the experimental post-decode expression API.

## [0.1.12] - 2026-08-31

### Changed

- Short-circuited arbitrary nested post-decode `when` expressions per worker block, routing only matching Splats through each AND/OR/NOT branch and compacting survivors before evaluating patch outputs.
- Reworked post-decode flow compilation with logical constant folding, iterative condition traversal, and reusable generation-based register maps, avoiding call-stack limits and repeated register-map allocation for deeply nested or shared condition graphs.
- Reduced post-decode condition-flow compilation scratch memory by allocating its traversal stack only for logical branches, storing only pending AND/OR continuations, and remapping emitted flow nodes directly without reachability or ordering passes.
- Enforced fixed 4096-instruction and 4096-flow-node post-decode limits, rejecting oversized programs instead of falling back to eager condition evaluation.
- Specialized post-decode unary, binary, ordered-comparison, and vector-construction block loops so opcode and vector-width dispatch no longer runs once per Splat.
- Reduced decode-worker setup and execution overhead with packed `Uint16Array` bytecode, stage-indexed register carry events, precomputed instruction and output-write plans, and field-major patch and spherical-harmonic writeback.

## [0.1.11] - 2026-08-30

### Changed

- Evaluated dynamic post-decode `when` guards before output-only expressions and compacted matching Splats within each worker block, skipping unnecessary attribute reads and arithmetic for rejected Splats.
- Pruned unused post-decode instructions, constants, and attributes during serialization, including folding constant `when` conditions.
- Reused post-decode temporary registers after their final use and allocated exact value widths, reducing worker scratch memory and increasing block sizes for long expression programs.
- Replaced recursive post-decode liveness traversal with an iterative worklist so maximum-length programs do not depend on the JavaScript call-stack limit.
- Avoided redundant `NaN` initialization before fully copying sort-center updates.

## [0.1.10] - 2026-08-29

### Changed

- Treated `streamLength` as an optional progress estimate for caller-provided streams instead of requiring it to match the decoded byte count exactly.
- Simplified byte-array and chunked-stream decoding without intermediate `ReadableStream` wrappers.

### Fixed

- Cancelled and released caller-provided stream readers when loading or worker decoding fails.

### Removed

- Removed the internal shared `workerPool` from the package entry-point exports.

## [0.1.9] - 2026-08-28

### Added

- Exported the shared `workerPool` from the package entry point.

## [0.1.8] - 2026-08-28

### Fixed

- Initialized the shared empty Splat texture with zero-valued pixel data so WebGL texture-array uploads no longer select an invalid pixel-unpack-buffer path.

## [0.1.7] - 2026-08-28

### Added

- Added read/write `GaussianSplatRenderer.transparent`, `depthTest`, and `depthWrite` properties for changing material behavior after construction.

## [0.1.6] - 2026-08-28

### Changed

- Reduced accumulator shader work by projecting quaternion vector parts directly during octahedral encoding and constructing packed SH scale factors from exact float exponent bits.
- Reduced rendering shader work by clipping ordinary Gaussian support to the configured alpha threshold, precomputing wide-kernel powers per vertex, and projecting covariance without intermediate matrices.

### Fixed

- Preserved wide-kernel semantic opacity when applying SDF opacity edits or mesh-wide opacity, including fully hiding meshes whose opacity is zero.

## [0.1.5] - 2026-08-27

### Added

- Added `Splats.getByteLength()` for current retained array storage.

## [0.1.4] - 2026-08-27

### Added

- Added `GaussianSplatRenderer.shrinkResources()` for synchronizing the current scene and shrinking renderer work resources to their current allocation tiers while preserving the current display until any replacement is ready.
- Added `setSplats()`, `pushSplats()`, and `removeSplats()` batch mutation APIs to `Splats` and `SplatMesh`, with optional SH0/1/2/3 input and aligned main, spherical-harmonic, and sort-center data.
- Added `postDecode`, a serializable per-Splat expression API for transforming logical position, scale, quaternion, opacity, alpha, color, and spherical harmonics inside the decode worker, with support for external attributes.

### Changed

- Changed the default `GaussianSplatRenderer.minAlpha` from `0.5 / 255` to `1 / 255`.
- Made the encoded Splat, sort-center, and SH array properties private.
- `Splats.getSplat()` now returns decoded spherical-harmonic coefficients by default; pass `false` to skip SH decoding.
- Replaced `Splats.reinitialize()` with a unified `initialize()` entry point, rejected conflicting initialization inputs, and isolated asynchronous initialization so superseded work cannot overwrite newer data.
- Made direct encoded-array initialization and the Splat record encoder internal implementation details; code-generated data now uses the managed `setSplats()` and `pushSplats()` APIs.
- Optimized `pushSplats()` and `setSplats()` with direct center-array views, common opacity and identity-quaternion fast paths, and no transient append-index or per-coefficient SH arrays, while preserving whole-batch validation.
- Optimized `removeSplats()` by compacting contiguous survivor ranges and using already sorted unique removal indices without temporary sets or sorting.
- Cleared mappings when pooled accumulators are disposed during resource cleanup, and released CPU ordering buffers when the renderer is disposed.
- Renamed the SDF blend modes to `MULTIPLY_RGBA`, `SET_RGBA`, and `ADD_RGBA`; all modes now modify only explicitly assigned color and opacity channels.
- Scaled idle decode-worker lifetime from three minutes at 64 MiB of peak WASM memory down to three seconds at 256 MiB, and preferred smaller idle workers for reuse so large workers can expire promptly.
- Generated contiguous raw sort centers during decoding and cached them in the sort worker; axial sorting now folds each mesh matrix into the view direction without materializing transformed centers, radial sorting creates transformed centers lazily, and switching modes replaces the worker and releases its previous WASM instance.
- Made the renderer's ordering texture internal and reused two transferable ordering buffers across depth sorts, avoiding per-sort allocations while keeping the texture's CPU-side data attached.

### Removed

- Removed the public `SplatSource` extension interface; `SplatMesh` now accepts only the built-in `Splats` data source.

## [0.1.3] - 2026-08-25

### Added

- Added the `SET_RGB` SDF RGBA blend mode, which replaces RGB while multiplying the existing alpha by the SDF opacity.

### Changed

- Reworked SPZ v4 decoding to process Zstandard streams incrementally with bounded buffers and to skip supported header-extension data.
- Passed logarithmic scales directly through the PLY/SPZ decode and generation pipelines, avoiding redundant exponential and logarithmic conversions.
- Deferred fetching each Splat's second texture record until its center passes view-frustum checks.
- Disposed idle decode workers after three seconds so completed loads do not retain the full worker pool.

### Fixed

- Treated `streamLength` as an exact byte count, rejecting invalid, truncated, or oversized streams before unsafe SPZ allocation.
- Validated SPZ point counts and packed renderer allocation sizes, with a default 2 GiB packed-model limit.

## [0.1.2] - 2026-08-25

### Changed

- Standardized source and accumulator records with alpha in the low float16 lane and special-kernel shape amount in the high float16 lane of the first record's final word.
- Updated TypeScript and Rust encoders to preserve raw source opacity through 1000 by storing its nonlinear LoD kernel encoding in the shape-amount lane and reconstructing the raw value for public reads.
- Removed the separate shape texture attachment and render-time texture fetch.
- Reused retired sort-center mesh IDs so Worker/WASM cache slots stay bounded by active scene churn rather than lifetime mesh count.

### Removed

- Removed `SplatAccumulator.getSplatShapeTexture()` now that generated shape data is carried by the main records.

## [0.1.1] - 2026-08-24

### Changed

- Standardized accumulator intermediates on the two-record representation, preserving camera-relative positions as 32-bit floats and color, alpha, and log-scale values as 16-bit floats.
- Kept enlarged SDF kernel shape independent from opacity and clamped generated opacity to the standard `[0, 1]` range.

### Removed

- Removed the `accumPackedSplats` option and the packed accumulator codec, shader path, and Viewer control.
- Removed the `focalDistance` and `apertureAngle` options together with the built-in depth-of-field shader path and Viewer controls.
- Removed the obsolete `LN_SCALE_MIN` and `LN_SCALE_MAX` exports that were only used by packed accumulator quantization.

## [0.1.0] - 2026-08-24

### Added

- Initial public release of the Three.js Gaussian Splatting renderer.

[Unreleased]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.16...HEAD
[0.1.16]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/788ba378ac5e3b2358313f625c4c466edd8c6fc5...v0.1.1
[0.1.0]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/releases/tag/v0.1.0
