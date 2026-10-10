# Architecture

[Back to documentation](../README.md#documentation)

This guide is for contributors. It describes internal module boundaries, backend differences, and resource lifetimes. To use the library, start from the [README](../README.md#quick-start) and the API pages it lists; those pages describe behavior, and this one explains how it is implemented.

[`src/index.js`](../src/index.js) defines the runtime exports, and [`src/index.d.ts`](../src/index.d.ts) defines the public type exports. Implementations use JavaScript with adjacent `.d.ts` files; modules containing only types need no JavaScript file. Applications use `SplatMesh` for models and one `GaussianSplatRenderer` for the scene.

## Source layout

| Directory | Responsibility |
| --- | --- |
| `src/data/` | Packed Splat data, codecs, texture layouts, and CPU reads |
| `src/scene/` | Scene objects, transforms, raycasting, and SDF edits |
| `src/loaders/` | File loading, decode requests, and load-time transforms |
| `src/loaders/postDecode/` | Expression building, compilation, register allocation, and execution |
| `src/loaders/rad/` | RAD source reads and container types |
| `src/loaders/sog/` | SOG source reads and ZIP access |
| `src/loaders/stream/` | Shared worker pools, budgets, options, and statistics |
| `src/loaders/stream/rad-stream/` | RAD loading, tree selection, fades, and page pools |
| `src/loaders/stream/sog-stream/` | SOG loading, visibility, chunk caches, and regions |
| `rust/gaussian-splat-lib/src/` | Platform-independent decoders and packed codecs |
| `rust/gaussian-splat-rs/src/` | WASM bridges, typed-array output, LOD selection, sorting, and raycasting |
| `src/runtime/` | Worker RPC, pooling, transferables, and WASM initialization |
| `src/utils/` | Numeric conversion, spatial transforms, and Three.js helpers |
| `src/patches/` | Three.js runtime compatibility fixes |
| `src/rendering/` | Shared updates, sorting handoffs, backend selection, and stochastic blue noise |
| `src/rendering/tsl/` | Shared TSL generation, projection, drawing, and view uniforms |
| `src/rendering/webgpu/` | Compute projection, projected caches, GPU sorting, and indirect drawing |
| `src/rendering/webgl/` | GLSL materials, texture generation, and CPU ordering uploads |
| `src/rendering/webgl-fallback/` | WebGPURenderer WebGL2 raster generation and ordering uploads |
| `src/rendering/lighting/` | Optional lighting: scene light records, lit shading for each material API, and the native surface cache |
| `src/capture/` | Optional offscreen targets, readback, cube captures, and PMREM filtering |
| `src/addons/` | Temporal anti-aliasing: `TAAPass` for WebGLRenderer, `TAANode` for WebGPURenderer, and their shared state |

`rendering/tsl/shaderUtils.js` provides shared shader and texture-load helpers. Modules use the Three.js TSL namespace directly, and declarations use Three.js types.

## Rendering boundaries

The renderer combines visible models using Three.js transforms, visibility, and layers. Initialize `WebGPURenderer` before creating `GaussianSplatRenderer`: the renderer type selects the material API, while its actual backend selects compute/storage or raster/textures.

| Owner | Responsibility |
| --- | --- |
| `GaussianSplatRenderer` | Scene updates, accumulator handoff, and sorting |
| `SplatCapture` | Independent capture Splat state, offscreen targets, readback, and PMREM |
| `SplatAccumulator` | Scene mappings, versions, camera-relative origin, and WebGL texture generation |
| WebGPU backend | Compute projection, caches, GPU sorting, and indirect drawing |
| WebGL backend | GLSL materials, ordering textures, and texture generation |
| WebGL fallback backend | Raster generation and CPU-sorted ordering textures |
| Shared TSL code | Generation and projection math, materials, and color conversion |

For sorted rendering, native WebGPU keeps ordering and visible counts on the GPU and sorts before drawing; its accumulator carries mappings and edit metadata without generating combined textures. Both WebGL backends use asynchronous Worker/WASM sorting and retain the previous display until a matching order is ready.

In `webgpu/`, `ProjectedSplats.js` coordinates projection and sorting, `ProjectionCache.js` owns projected storage, and `RadixSort.js` owns sort passes. WebXR uses the eyes' mean pose for generation and sorting, with separate projections for each eye. Both WebGL backends share `webgl/OrderingTexture.js` for allocation and disposal, while keeping their own upload and binding paths.

`backend.js` selects the backend from the renderer type and its public `coordinateSystem`, which distinguishes native WebGPU from WebGL fallback. It chooses the blend space for each output: the working color space by default, `renderer.outputColorSpace` when WebGLRenderer draws to the canvas, and the target texture's color space when it draws to an XR-style target.

Projected Splat support is capped at the viewport's short side, in projection space scaled by `focalAdjustment`, in both the TSL projection program and the GLSL vertex shader. The quad and its UV extent shrink by the same ratio, preserving the Gaussian profile.

A kernel still above `minAlpha` where its support ends is faded there instead of cut off. The fragment stage rescales it about its peak, `(alpha + fade) * kernel - fade`, so it reaches `minAlpha` at the support edge. The quad is never enlarged.

- **Gaussians.** Only `maxStdDev` can end a Gaussian early, so its fade follows from its alpha and the per-draw `edgeFade` uniform, a scale and offset derived from `maxStdDev` and `minAlpha`. It needs no per-Splat data, and a Gaussian that `minAlpha` already ends is drawn exactly as before.
- **Wide kernels.** The edge value depends on the kernel power, so the projection computes the fade and stores it as a half in the low 16 bits of the squared support radius. That radius is first rounded down to its high 16 bits, at most 0.6% of the radius, which keeps the fragment stage's radius test exact. The squared radius therefore passes to the fragment stage bit for bit, and native WebGPU caches it in place of the radius.

Errors from automatic updates are caught and logged once per message; a draw whose preparation fails is skipped. Explicit `update()` calls rethrow to the caller. `frameCallbacks` is an internal flag for a second renderer on the same scene, so each `SplatMesh.onFrame` runs once per frame.

Resource rules:

- Wait for outstanding GPU compilation before disposing the sorter; preserve compute nodes when resizing resources or changing source meshes.
- Keep color conversion and XR output handling with the backend that owns them.

### Stochastic rendering

Sorted and stochastic draws compile separate shaders without mode branches. A mode change takes effect at the next update boundary, after the current draw; both WebGL backends also wait for the matching accumulator and sort, and `stochasticActive` reports the mode being drawn. Stochastic draws use the opaque list with depth testing and writing.

Coverage uses a tileable 32-frame spatiotemporal blue-noise atlas (`blueNoise.js`, generated by `scripts/generate-blue-noise.js`) on all backends. Each Splat keeps its own spatial offset and temporal phase, so consecutive samples follow the atlas's time axis instead of choosing unrelated offsets. The temporal sequence is optimized for exponential history accumulation and wraps after 32 samples. `stochasticSample` advances once per scene render, and every view in that render shares it.

Seeds exist only for stochastic draws: WebGL accumulators omit the seed layer in sorted rendering, and native WebGPU allocates its seed buffer on demand. Front-to-back stochastic ordering uses 16-bit keys. With unsorted stochastic rendering, `shrinkResources()` releases the sort worker and ordering.

### Lighting

Lighting lives in `rendering/lighting/`. A Splat is lit once, at its center, in the vertex stage: its color is the albedo, and its normal is estimated from its shape. Unlit draws keep their own materials and kernels.

| Module | Responsibility |
| --- | --- |
| `SplatLighting.js` | One renderer's lighting: the shading its backend draws with, and the lights collected before each draw |
| `SceneLights.js` | The lights a camera sees, written on the CPU as packed view-space records; the record layout is documented there |
| `LightData.js` | Shared, resizable read-only storage buffer on native WebGPU or data texture on both WebGL paths; the shader interface stays fixed |
| `tsl/surface.js`, `webgl/surface.glsl` | The estimated normal |
| `tsl/shading.js`, `webgl/shading.glsl` | Diffuse evaluation of the light records |
| `webgpu/SurfaceCache.js` | Native WebGPU only: the normal's storage beside the projection cache, and the center recovered from the cached projection |

The TSL and GLSL files are twins; change them together. Light counts and per-eye block strides are runtime data. Growing or explicitly shrinking light storage preserves cached draw materials and pipelines. Three's scene-light graph remains part of node draw caching and can independently rebuild shaders when scene lights change.

`GaussianSplatRenderer.js` is the only module outside the folder that imports it. The rest of the renderer knows lighting only as shading, through two interfaces:

- **Shaded materials.** Each backend's `selectMaterial(stochastic, shading)` returns its plain material or, given a `shading`, the variant whose vertex stage recolors every Splat; `MaterialVariants` builds that variant on first use. Node materials take a projection extension, which derives the surface while the Gaussian is projected, and a `shade` function. The GLSL material takes the code for the two shading includes of `splatVertex.glsl`.
- **Shaded kernels.** Native WebGPU projects in compute kernels, so the draw never sees a Gaussian's shape. `ProjectedSplats` keeps a second set of kernels for each eye count, which also run the extension and store its output through `surfaces`, in a channel of `ProjectionCache`. The backend selects them together with a shaded material. The renderer passes `SplatLighting.createSurfaces` when it creates the backend, so these kernels precompile with the others.

Changing `lighting` selects the material and matching native kernels before rendering. Three.js handles draw-shader compilation for each camera and render target through its normal rendering path. Light records update as uniforms; Three.js scene-light cache changes can rebuild node draw shaders, but do not recompile compute kernels. The projection cache does not depend on lights.

## Capture boundaries

[SplatCapture](SplatCapture.md) is optional; the core renderer allocates no capture resources.

- **Independent Splat state.** The helper owns an internal `GaussianSplatRenderer` with `autoUpdate` and stochastic rendering off, sharing the display renderer's timer, loaded Splat data, and model-owned SDF edit textures. Its accumulators, sorting, and projection resources are separate, so display ordering and camera state are untouched. Global and model-local edits apply to captures and follow their latest values. `frameCallbacks` is off, leaving `onFrame` to the display renderer.
- **Stencil captures.** 2D and cube targets follow the Three.js renderer's stencil setting, with no separate capture option; a 2D target without a depth buffer gets no stencil, since Three.js attaches stencil only with depth. The intermediate target uses a depth-stencil attachment when stencil is enabled. With stencil, intermediate depth is 32-bit float for a float output depth texture or a default attachment with reversed depth; otherwise it is 24-bit. The scene's stencil masking applies before copying its color and depth to the output.
- **Options.** Quality, sorting, and material options are copied from the supplied renderer at the start of each capture. The active Splat material's stencil comparison and write settings are copied as well. Cube captures force radial sorting. The internal renderer takes the capture camera's layer mask.
- **Two phases.** Preparation awaits `update()` on the original scene with an explicit set of excluded objects. Collection skips models under those objects without changing visibility, while global edits follow the original scene's visibility. If the display updates shared models during a pending sort, preparation runs again with the same exclusions; appearance-only changes reuse the ordering. The draw is synchronous: other Splat renderers' layer masks are cleared, `hideObjects` are hidden, and the internal renderer joins the scene. `withCaptureState()` saves and restores the render target, cube face, mip level, XR setting, automatic clearing, and MRT. Nothing stays changed across an `await`, and everything is restored when drawing throws.
- **Ordering.** Captures on one helper are queued and run in call order. The camera or `worldCenter` is copied when the call is made. `renderReadTarget()` and `renderEnvMap()` read or filter inside the same queued task, before a later capture can redraw the target.
- **Cube captures.** Splat data is prepared at `worldCenter` with a 90° camera, then six faces render with automatic updates off. Both WebGL backends share one radial CPU sort across the faces; native WebGPU projects, compacts, and sorts for each face while drawing. Every capture runs `update()`, whose version checks reuse valid data and ordering, so 1.1.8's `update` option is not offered. Mipmaps are generated after the sixth face. Filtered and unfiltered cubes use separate targets, reallocated when size, clipping planes, or the renderer's stencil setting change.
- **Color.** `WebGLCapture` renders into an intermediate flagged as an XR-style target, 8-bit unless the output is float, so materials convert to the output color space before blending as on the canvas; a full-screen pass then converts to the target's storage space and copies depth. `WebGPUCapture` renders in the working color space, then applies the renderer's output transform and converts to storage space. On both, float outputs keep their type so values stay unclamped, and the intermediate takes the output's sample count, so multisampling applies to the scene and not to the final pass.
- **Readback.** `pixels.js` returns packed RGBA8 with the bottom row first on every backend, flipping native WebGPU's top-left origin. Three.js returns tightly packed rows. Supersampled targets are box-filtered on the CPU. Cube faces are normalized to the WebGL cube render target layout: native WebGPU stores +X and −X swapped and reads each face rotated 180°.
- **Ownership.** `dispose()` releases the internal renderer, 2D and cube targets, readback buffers, and the PMREM generator. Each texture from `renderEnvMap()` belongs to the caller; disposing it also releases its PMREM render target.

## Temporal anti-aliasing boundaries

[TAAPass and TAANode](TAAPass.md) are derived from Three.js TRAA, without a velocity attachment: reprojection uses scene depth and camera motion only, so object motion is not tracked.

- `taaShared.js` owns the state both share: a 32-entry Halton(2, 3) jitter sequence, jittered and unjittered projections, previous-frame matrices, the history index, sizing, and reset. It supports custom projections, scaled rigs, reversed depth, and logarithmic depth.
- Each implementation captures the scene itself into a half-float target with a depth texture and resolves between two history targets, with no history copies. The resolve applies depth rejection away from edges, neighborhood clipping, and luminance-aware blending.
- The capture target takes a stencil buffer when the Three.js renderer has one; the history targets never do, since the resolve writes only color and depth. Depth stays 32-bit float on every backend.
- The camera's projection is jittered only during capture. Native Splat projection reads the unjittered matrix through `getTAAProjection()`, so projection and sorting results are reused while only the jitter changes.
- `TAAPass` flags its capture target as an XR-style target, so Three.js converts materials to `renderer.outputColorSpace` before blending, matching canvas blending. Tone mapping is disabled during capture. The final copy decodes the sRGB transfer into the composer's working-space buffer, the inverse of `OutputPass`, so the two round-trip at any alpha; as the last pass it presents the output-space image unchanged. An output color space change resets history.
- `TAANode` is a TSL node updated once per render. It captures and accumulates in `ColorManagement.workingColorSpace`, leaving tone mapping and output conversion to `RenderPipeline`. A working color space change resets history.

## Decoder boundaries

PLY, SPZ, SOG, and RAD decode in `gaussian-splat-lib` and publish through `SplatReceiver`. This core library has no JavaScript or WASM dependency. `gaussian-splat-rs` adapts browser inputs and writes the output into JS typed arrays through `SplatsData`.

- PLY/SPZ consume byte streams through `ChunkReceiver`.
- SOG decodes property-image groups into bounded batches. Metadata, ZIP validation, images, and SH palettes belong to the core decoder; `SogDecodeSession` bridges that API to JavaScript.
- RAD retains dataset codebooks between page requests and returns packed records with separate tree metadata.

[`loadSplatData`](../src/loaders/loadSplatData.js) coordinates decoding, resolvers, cancellation, progress, and loading-manager callbacks, returning packed `SplatResult` data without importing scene classes. `Splats` uses it for initialization; `SplatLoader` adapts it to the Three.js loader API. Completion callbacks run before the loading manager ends the item.

`RadSource` and `SogSource` share reads, request settings, and cancellation through `loaders/source.js`. Companion-file resolvers run on the calling thread, and caller-owned buffers are copied before transfer. See [SplatLoader](SplatLoader.md) for the public loading API.

## Post-decode boundaries

The [postDecode](PostDecode.md) API builds expressions on the calling thread and executes them in decode workers:

| Module | Responsibility |
| --- | --- |
| `program.js` / `builder.js` | Public API, program identity, typed expressions, and patch validation |
| `protocol.js` | Opcodes, packed layouts, and shared types without builder or runtime dependencies |
| `optimizer.js` | Fusion of single-use arithmetic intermediates before compilation |
| `compiler.js` | Conditional flow, dependencies, packed instructions, and attribute snapshots |
| `registers.js` | Runtime register allocation and values carried between condition stages |
| `operations.js` / `runtime.js` | Packed input reads, block execution, conditions, and output writes |

Decode workers import runtime and protocol modules directly, keeping expression construction and compilation outside their dependency graph.

## Shared streaming boundaries

Loaders own transport and parsing; schedulers own selection, fades, publication, and retirement.

- `StreamWorkerPool.run()` queues worker leases, assigns task IDs, links cancellation, counts downloads, and balances loading-manager notifications. Each loader has its own pool; format-specific callbacks retain SOG caches or release RAD decoder slots.
- `IndexedSplats` shares texture storage and selected-index reads between `RadPagedSplats` and `SogRegionSplats`. Slot assignment and scene attachment remain with the format-specific scheduler and batch classes.
- `StreamCameras.js` owns the registered cameras and their resolutions, and expands a WebXR `ArrayCamera` into its eye views once they have a projection and viewport.
- `streamOptions.js` owns shared defaults, validation, retry classification, and statistics. `StreamByteBudget` bounds pending copies separately from active loads; ready data has no per-update byte allowance.

`splatBudget` controls selected detail, not total memory. Resident-byte estimates exclude pending copies and WASM memory, which are reported separately; resident storage has no byte cap. Pending copies allow 8 MiB per concurrent load (32 MiB by default), enlarged for an indivisible RAD page; one oversized item can proceed alone. This bounds the waiting queue, not the bytes published or uploaded per frame.

Applications must keep calling `update()` while waiting for `firstRenderable` and while loading, fades, retries, or retirement need to advance. `onChange` requests redraws; it does not drive scheduler updates. Schedulers update ordinary camera matrices, but read a WebXR camera's eye matrices directly and select detail for each eye. Streaming updates before rendering may use the previous frame's XR pose.

## Streamed SOG boundaries

[SogStreamScheduler](SogStreamScheduler.md) loads `lod-meta.json` scenes. Ordinary `.sog` files and `meta.json` use the regular model loader.

- `sogLod.js` parses manifests and selects LOD targets using `splatBudget`. `SogVisibility` keeps the spatial tree and distance-based priorities in the LOD worker.
- `SogStreamLoader` owns the LOD worker, decoding pool, and cached chunk sources.
- `SogStreamBatch` owns occupied slots and mesh attachment; `SogRegionSplats` owns indexed region data.
- `SogStreamScheduler` owns per-region targets, pending extractions, current/outgoing regions, fades, and retirement. It reuses cached detail and refines large gaps gradually. Each region finishes its current crossfade before admitting another LOD.

SOG retains resources per chunk and region:

| State | Owned resources and release point |
| --- | --- |
| Chunk load | Abort controller and loading slot remain until the request settles; successful decoding retains a worker cache handle |
| Cached chunk | Decoded worker data and its worker lease remain while wanted, loading, or needed by visible/fading regions or pending extractions; otherwise they release after `cooldownMs` milliseconds |
| Pending extraction | Target range, chunk reference, and reserved bytes remain until extraction settles; stale results are discarded |
| Ready region | Copied records and pending bytes remain until upload writes them into a batch slot or a target change discards them |
| Current region | Batch slot and opacity state remain while visible or fading; a hidden region releases after cooldown once no outgoing region remains |
| Outgoing region | Previous LOD slot remains until its fade-out finishes, then releases immediately |
| Batch storage | A chunk's shared mesh and source storage remain while any region slots are occupied; releasing the last slot disposes both |

Pending extractions keep their chunk cache referenced, even if the target changes before the reply arrives. Replies are accepted only while the scheduler is alive and the pending region still matches the target. Disposal stops workers, releases chunk caches and region slots, and clears pending state.

## RAD boundaries

[RadStreamScheduler](RadStreamScheduler.md) loads RAD scenes with a LOD tree. Ordinary RAD loading validates the full tree and extracts leaves before applying `postDecode`.

- `RadSource` owns bounded reads, HTTP Range consistency, companion-page resolution, and cancellation.
- `RadStreamLoader` owns a dedicated LOD worker and a bounded decoding pool. Packed geometry transfers to the calling thread; tree arrays transfer to the LOD worker. Decoder slots release after decoding, while pending-byte reservations remain until tree registration and publication can complete.
- `rad_lod.rs` selects a camera-dependent tree cut using file-global node indices. Children replace parents only as complete groups. `radFade.js` compares selections and prepares transitions in the LOD worker.
- The LOD worker retains each chunk's inverse Morton order and block bounds until chunk release. `prepareRadSelection.js` builds render indices and merges current/post-fade bounds together; publication and fade completion switch indices and bounds together on the calling thread.
- `RadStreamScheduler` owns page requests, slot occupancy, publication, fades, retries, and retirement. `RadPagedSplats` and `RadStreamBatch` own page storage and selected-index data. Shared nodes render once, and at most two selections overlap during a fade.

The scheduler retains resources through these stages:

| State | Owned resources and release point |
| --- | --- |
| Page load | Abort controller, phase, and reserved bytes remain until the load settles, including after cancellation |
| Decoded page | Packed buffers and an optional reserved pool slot remain until writing creates resident storage and drops the buffers |
| Resident page | Pool and slot remain allocated until retirement clears both the page allocation and slot entry |
| Traversal | Snapshot page pins, previous cut, and requested budget remain until traversal settles |
| Ready cut | Selection and page pins are consumed on publication or released on invalidation |
| Preparation | Pool snapshots, page pins, and pending bytes remain until the result is consumed or discarded; cancellation prevents publication |
| Displayed cut | Selection, protected pages, and fade state are replaced together on publication or cleared when hidden |

Page pins prevent retirement while traversal, preparation, or display still needs the data. They do not renew cooldowns. Unused pages retire during cleanup after fade-out and `cooldownMs` milliseconds; empty pools release their storage. Root and traversal ancestors remain available for coarsening. Decode generations prevent stale cancellation from releasing replacement pages.

Budget changes invalidate pending selections while preserving the displayed cut. Hiding clears the displayed cut and wanted pages. Disposal terminates workers before dropping their snapshots and page pools.

Both schedulers defer expired-cache retirement while a new LOD decision is pending, preserving the original expiry times. Each accepted decision updates wanted data before cleanup, allowing cache reuse after an update pause and regular retirement during continuous camera movement. SOG also protects newly selected regions before their opacity recovers. Hidden scenes can continue cleanup without waiting for a new selection; existing resource pins still apply.

`SplatOpacityTable` separates source-block group IDs from opacity coefficients. SOG regions fade independently; RAD uses stable, incoming, and outgoing groups. Fade ticks change coefficients without rewriting source records or picking opacity.

## Imports and extensions

- Applications import from `gaussian-splat-lite`, including `utils` and `defines`; source paths are internal.
- Internal modules import helpers from their owner. `utils/index.js` is the public entry point.
- Keep scene updates and sorting handoffs in shared rendering code, with backend-specific storage and output handling in each backend.
- Keep options and types beside their owner. Shared uniform defaults must not import backends; native projected-cache layouts belong in `webgpu/`, separately from packed source layouts in `data/`.
- Keep numeric codecs separate from Three.js object unpacking so decode workers avoid scene dependencies.
