# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Prepared RAD render indices, opacity tables and post-fade cuts in the existing LOD worker, reducing main-thread selection work without adding workers.
- Initialized additional RAD streaming decoders from shared SH codebooks without decoding root geometry again.
- Accelerated RAD decoding with lookup tables and direct packing.
- Directly packed RAD `f32` SH and reused `f16` RGB and `ln_f16` scale bit patterns, preserving scale validation and LOD radii while reducing intermediate buffers and conversions.
- Accelerated SPZ and SOG decoding with lookup tables, reducing intermediate buffers.
- Accelerated byte-encoded SH packing in standard and SuperSplat compressed PLY.
- Cached packed RAD SH codebooks across chunks to avoid per-splat float expansion and encoding, including the caches in streaming memory estimates.
- Accepted SPZ degree-4 SH input while retaining only SH0–SH3 for rendering.
- Decoded ordinary RAD chunks into preallocated output, extracting LOD leaves as they decode and trimming output arrays after tree validation.
- Removed fixed size caps for RAD loading and decoding, SPZ packed models, and SOG ZIP directories.
- Removed the 4 GiB PLY/SPZ input-length restriction using 64-bit lengths and SPZ v4 byte counters, preserving incremental decoding and length validation.
- Reduced SOG streaming update and statistics overhead by tracking only active chunks.

## [1.0.2] - 2026-09-11

### Changed

- Allowed native WebGPU rendering after shared kernels, the full sorter, and the first projection slot compile, warming the remaining slots asynchronously.
- Used stable storage binding names to allow native WebGPU projection slots to share shader programs.
- Removed the separate native WebGPU indirect-draw reset dispatch by initializing fixed arguments once and updating instance counts in the projection finish pass, preserving the maximum count across views.

## [1.0.1] - 2026-09-11

### Added

- Added runtime `splatBudget` updates to `RadStreamScheduler` and `SogStreamScheduler`. Assigning a positive safe integer requests a new LOD selection even for stationary views, discards results computed for an older budget, and preserves displayed coverage through loading and fades.

### Changed

- Changed streamed SOG LOD selection to distance-based priorities with a level multiplier of 1.5, using camera-to-bounds distance instead of region size or authored errors.
- Changed streamed SOG refinement to use the finest cached LOD up to the target. Gaps of at least four levels load a midpoint; smaller gaps and coarsening load the target directly. Regions without usable coverage start at the coarsest LOD.
- Reworked RAD LOD scoring to prepare camera position and projection bounds once per view, using camera pixel scale and inverse object-space center distance for perspective and orthographic cameras. Nodes inside the actual viewport receive full priority, accounting for zoom and view offsets; off-screen priority tapers toward 5%, with 5% retained behind the camera. Non-invertible transforms are rejected.
- Changed RAD LOD radius estimates from the largest axis scale to the arithmetic mean of the three axis scales, lowered the base pixel threshold from `2` to `1`, and reduced hysteresis from 15% to 5%.
- Reduced RAD traversal work by marking child ranges per page, skipping per-node work on leaf-only pages, and pruning refinements that cannot fit the remaining budget while preserving single-child refinements and stable source order.
- Kept RAD selection baselines in the LOD worker and referenced them by ID, avoiding per-request copies of the displayed cut. Combined changed-page detection and fade preparation into one pass, skipped fade-buffer allocation for unchanged cuts, and included retained worker selections in resident-byte statistics.
- Moved streamed RAD page downloads and local page reads into decoding workers, keeping application URL and file resolution on the calling thread. Preserved Range validation and checked resource versions and lengths across parallel responses before publication; local inputs send only the requested page.
- Reduced RAD streaming replies to packed render records and a scalar root radius, transferring tree arrays to the LOD worker without duplicate copies or unused sort centers on the main thread. Updated pending-byte estimates and removed the unreachable non-LOD radius fallback.
- Simplified internal RAD selection clearing and removed unused duplicate-index fade handling, keeping prepared selection commits and shared fade groups.
- Unified RAD/SOG load lifecycle handling in `StreamWorkerPool`, including worker leases, task IDs, cancellation, download accounting, and balanced `LoadingManager` notifications, while retaining separate pools and format-specific cache ownership.
- Reduced SOG streaming transfers and pending-copy reservations with tightly packed region records that omit per-region texture padding and duplicate sort centers.
- Reduced streamed SOG metadata to four fields per LOD, keeping the spatial tree and a float32 upgrade-ratio table in the LOD worker. Memory statistics include both threads' retained arrays.
- Shared ordering texture allocation, resizing and disposal between the WebGL backends while preserving their partial-upload paths; removed unused native WebGPU CPU-ordering members.
- Optimized `postDecode` by combining single-use multiply/add and add/multiply expressions while preserving intermediate float32 rounding and operand order, caching decoded scale values on demand, and combining related packed-field and sort-center writes.
- Compacted native WebGPU projection output into visible slots and repurposed the source-index buffer for stable coverage seeds, preserving the 32-byte projected record layout without an extra seed texture.
- Kept RAD validation and assembly helpers and TSL texture-layout constants local to their modules by removing unused exports.
- Set viewer camera damping to `0.1`.

### Removed

- Removed unused `SplatEdits.sdfFloatData` and `editFloatData` fields. Float views can be created from the current `sdfData.buffer` and `editData.buffer` when needed.
- Removed the unused `debugFlag` uniform and its automatic updates. Custom shaders that use it must now define and update their own uniform.
- Removed `utils.threeMrtArray`; all supported Three.js versions provide array-based multiple render targets.
- Removed the unused `mode` tag from the internal serialized `postDecode` condition format.

### Fixed

- Stabilized stochastic color and depth coverage when streamed LOD selections or combined mesh ranges are remapped. All three rendering backends now derive sampling seeds from mesh identity and physical source records, preventing unchanged Splats from receiving new noise patterns after remapping.
- Removed camera-rotation-dependent scale inflation from RAD LOD scoring.
- Corrected viewer overlay stacking so the drop overlay and toast messages appear above other controls.

## [1.0.0] - 2026-09-09

### Added

- Added `WebGPURenderer` support for native WebGPU, `forceWebGL`, and automatic WebGL2 fallback, using shared TSL shaders. Native WebGPU projects and culls Splats before 32-bit GPU sorting and indirect drawing; both WebGL backends use asynchronous Worker/WASM sorting. The new read-only `synchronousSort` property reports the backend's sorting mode.
- Added `stochastic` and `autoStochastic` for sorting-free transparency, plus `renderDepth` for companion depth draws with stochastic alpha coverage. Automatic mode uses stochastic rendering during camera motion until a fresh sort is ready.
- Added `StochasticResolvePass` for spatial noise reduction through direct scene composition, WebGL `EffectComposer`, or a custom render graph. Manual stochastic rendering and per-eye resolve support WebGL/WebGPU XR; automatic switching is disabled in XR.
- Added SOG V1/V2 loading from ZIP bundles or directory metadata through the existing loading APIs, with HTTP Range access, concurrent property-image downloads, and grouped decoding.
- Added Spark RAD version 1 loading for monolithic `.rad` files and split files with external `.radc` pages, including all property codecs and SH0–SH3/codebooks. Ordinary loading detects the RAD0 signature and extracts leaf records before applying `postDecode`.
- Added `RadStreamScheduler` and `SogStreamScheduler` for camera-driven LOD and on-demand loading of RAD pages and Streamed SOG `lod-meta.json` scenes. Both support WebGL/WebGPU rendering, SDF edits, raycasting, visibility fades, LOD crossfades, cancellation, retries, and streaming statistics.
- Added shared streaming controls for Splat budgets, upload allowance, load concurrency, and cooldown retirement. Defaults are 3,000,000 Splats, 8 MiB per update, four concurrent loads, 100 cooldown ticks, and 200 ms fades. LOD workers run separately from decoding workers and coalesce pending requests to the latest view; fixed source slots, compact visible indices, and partial uploads reduce repeated work.
- Added `resolveFile` for local SOG companion images and RAD pages, accepting synchronous or asynchronous URL, Blob, or byte-array results with cancellation support.
- Added an optional `AbortSignal` to `SplatLoader.loadAsync()`. Disposing loaded sources or replacing their initialization cancels pending downloads and decoding.
- Added `Splats.extractRange()` to copy packed records, spherical harmonics, and sort centers into an independent source.
- Added Splat record indices to raycast hits and `RadStreamScheduler.getGlobalIndex()` to map current batch indices to stable file-global RAD node indices.
- Added viewer backend switching, output color-space and stochastic controls, WebGPU Inspector integration, and a toggleable grid with X/Z reference axes. The viewer accepts SOG/RAD files, streamed scene URLs, and multi-file selection or drop for local split assets.

### Changed

- Updated the Three.js peer dependency from `>=0.185.1` to `>=0.186.0`, pinned development to `0.186.0`, and removed compatibility workarounds fixed upstream.
- Replaced `stream` and `streamLength` loading inputs with `file: Blob` (including `File`) in `Splats` and `SplatMesh`. PLY/SPZ files stream inside the worker; local SOG/RAD files use random reads. Existing `url` and `fileBytes` inputs remain available.
- Changed the default `preBlurAmount` from `0` to `0.3` and `blurAmount` from `0.3` to `0`, expanding projected Splats without the previous blur opacity compensation. Set them to `0` and `0.3`, respectively, to restore the previous behavior.
- Corrected `minPixelRadius` to use screen pixels independently of `focalAdjustment`. Its default remains `1`; divide previous values by `focalAdjustment` to preserve the old cutoff.
- Increased the default `SplatMesh.minRaycastOpacity` from `0.1` to `0.15`.
- Moved built-in Splat color conversion to vertex shaders and trimmed wide-kernel coverage using a conservative alpha bound while preserving the full-support visibility cutoff. Native WebGPU projection quantization can produce slight visual differences, and equal-depth Splats have no guaranteed source order.
- Unified PLY/SPZ/SOG/RAD decoding around the platform-independent Rust library and shared receiver output, with thin WASM bridges. Reused PLY batches and SPZ decompression buffers, and reduced packed-buffer reads, writes, and temporary allocations.
- Reorganized source code into data, loaders, runtime, scene, rendering, and utility modules while preserving existing package entry-point exports. Extracted offscreen capture, shared packed-data loading, and separate post-decode building, compilation and execution modules without changing public APIs. Simplified the README and API references, and added architecture and streaming guides.
- Updated the viewer to use reversed depth buffers where supported and allow only one GPU frame in flight while retaining pending redraws and processing camera input. Replaced the bundled Lion model with Multi Material Splats by hybridherbst in SPZ v4 with SH3 data and CC BY 4.0 attribution.
- Changed `npm run dev` to serve source directly through Vite, consolidated WASM builds into a cross-platform Node script, and split ES module and CommonJS bundle builds. Removed `build:watch` and the platform-specific WASM scripts.

### Fixed

- Corrected shared SH exponent selection in Rust and TypeScript so coefficients between powers of two no longer saturate at the lower power. Preserved finite color channels when another channel is NaN, and preserved the SH2 coefficient stored alongside SH1 when updating SH1. The packed layout and shader decoding are unchanged.
- Rebuilt Splat textures when either source buffer, typed-array offset, or length changes, preventing stale GPU data.
- Validated legacy SPZ gzip header and payload checksums, decoded sizes, trailers, and trailing data. Validated SPZ v4 Zstandard checksums and declared frame sizes against the stream table, rejecting corrupt or inconsistent files.
- Corrected WebXR projection to use each eye's viewport dimensions instead of the full drawing buffer.
- Recreated terminated WebGL sorting workers on the next sort and discarded late sorting results after renderer disposal.

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

- Added `tan`, `asin`, `atan`, and vector-aware `atan2(y, x)` operations to the post-decode expression API.

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

[Unreleased]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.16...v1.0.0
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
