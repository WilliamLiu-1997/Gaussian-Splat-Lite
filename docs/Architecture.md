# Architecture

[Back to documentation](../README.md#documentation)

[`src/index.ts`](../src/index.ts) defines the public exports. Applications use `SplatMesh` for models and one `GaussianSplatRenderer` for the scene. This guide describes the internal module boundaries and resource lifetimes; see the [README](../README.md#quick-start) for setup.

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
| `src/rendering/` | Shared updates, sorting handoffs, depth, captures, and stochastic resolve |
| `src/rendering/webgl/` | GLSL materials, texture generation, CPU ordering uploads, and readback |
| `src/rendering/tsl/` | Shared TSL generation, projection, drawing, resolve, and view uniforms |
| `src/rendering/webgpu/` | Compute projection, projected caches, GPU sorting, and indirect drawing |
| `src/rendering/webgl-fallback/` | WebGPURenderer WebGL2 raster generation and ordering uploads |

## Rendering boundaries

The renderer combines visible models using Three.js transforms, visibility, and layers. Initialize `WebGPURenderer` before creating `GaussianSplatRenderer`: the renderer type selects the material API, while its actual backend selects compute/storage or raster/textures.

| Owner | Responsibility |
| --- | --- |
| `GaussianSplatRenderer` | Scene updates, accumulator handoff, sorting, stochastic transitions, and companion depth |
| `SplatCapture` | Offscreen targets, supersampled readback, cube captures, and environment-map filtering |
| `SplatAccumulator` | Scene mappings, versions, camera-relative origin, and WebGL texture generation |
| `StochasticResolvePass` | Scene composition, noise reduction, XR eye layout, and renderer-state restoration |
| WebGL backend | GLSL materials, ordering textures, texture generation, readback, and PMREM |
| WebGPU backend | Compute projection, caches, GPU sorting, and indirect drawing |
| WebGL fallback backend | Raster generation and CPU-sorted ordering textures |
| Shared TSL code | Generation and projection math, materials, color conversion, readback, and PMREM |

For sorted rendering, both WebGL backends use asynchronous Worker/WASM sorting and retain the previous display until a matching order is ready. Native WebGPU keeps ordering and visible counts on the GPU and sorts before drawing; its accumulator carries mappings and edit metadata without generating combined textures. Stochastic rendering skips sorting.

In `webgpu/`, `ProjectedSplats.ts` coordinates projection and sorting, `ProjectionCache.ts` owns projected storage, and `RadixSort.ts` owns sort passes. Both WebGL backends share `webgl/OrderingTexture.ts` for allocation and disposal, while keeping their own upload and binding paths.

Resource rules:

- Wait for outstanding GPU compilation before disposing the sorter; preserve compute nodes when resizing resources or changing source meshes.
- Keep color conversion and XR output handling with the backend that owns them.
- `SplatCapture` owns cube targets and PMREM generators per renderer instance and releases them on disposal. Callers dispose textures returned by `renderEnvMap()`, which also releases their output render targets.
- Capture scopes restore the renderer override, render target, and sorted-render state after use.

## Decoder boundaries

PLY, SPZ, SOG, and RAD decode in `gaussian-splat-lib` and publish through `SplatReceiver`. This core library has no JavaScript or WASM dependency. `gaussian-splat-rs` adapts browser inputs and writes the output into JS typed arrays through `SplatsData`.

- PLY/SPZ consume byte streams through `ChunkReceiver`.
- SOG decodes property-image groups into bounded batches. Metadata, ZIP validation, images, and SH palettes belong to the core decoder; `SogDecodeSession` bridges that API to JavaScript.
- RAD retains dataset codebooks between page requests and returns packed records with separate tree metadata.

[`loadSplatData`](../src/loaders/loadSplatData.ts) coordinates decoding, resolvers, cancellation, progress, and loading-manager callbacks, returning packed `SplatResult` data without importing scene classes. `Splats` uses it for initialization; `SplatLoader` adapts it to the Three.js loader API. Completion callbacks run before the loading manager ends the item.

`RadSource` and `SogSource` share reads, request settings, and cancellation through `loaders/source.ts`. Companion-file resolvers run on the calling thread, and caller-owned buffers are copied before transfer. See [SplatLoader](SplatLoader.md) for the public loading API.

## Post-decode boundaries

The [postDecode](PostDecode.md) API builds expressions on the calling thread and executes them in decode workers:

| Module | Responsibility |
| --- | --- |
| `program.ts` / `builder.ts` | Public API, program identity, typed expressions, and patch validation |
| `protocol.ts` | Opcodes, packed layouts, and shared types without builder or runtime dependencies |
| `compiler.ts` | Conditional flow, dependencies, packed instructions, and attribute snapshots |
| `registers.ts` | Runtime register allocation and values carried between condition stages |
| `operations.ts` / `runtime.ts` | Packed input reads, block execution, conditions, and output writes |

Decode workers import runtime and protocol modules directly, keeping expression construction and compilation outside their dependency graph.

## Shared streaming boundaries

Loaders own transport and parsing; schedulers own selection, fades, publication, and retirement.

- `StreamWorkerPool.run()` queues worker leases, assigns task IDs, links cancellation, counts downloads, and balances loading-manager notifications. Each loader has its own pool; format-specific callbacks retain SOG caches or release RAD decoder slots.
- `IndexedSplats` shares texture storage, selected-index reads, and upload accounting between `RadPagedSplats` and `SogRegionSplats`. Slot assignment and scene attachment remain with the format-specific scheduler and batch classes.
- `streamOptions.ts` owns shared defaults, validation, and statistics. `StreamByteBudget` accounts for pending copies and per-update uploads separately from active loads.

`splatBudget` controls selected detail, not total memory. Resident-byte estimates exclude pending copies and WASM memory, which are reported separately; resident storage has no byte cap. Upload allowance is an estimate and can admit one oversized item, so it is not a strict per-frame GPU upload limit.

Applications must keep calling `update()` while waiting for `firstRenderable` and while loading, fades, retries, or retirement need to advance. `onChange` requests redraws; it does not drive scheduler updates.

## Streamed SOG boundaries

[SogStreamScheduler](SogStreamScheduler.md) loads `lod-meta.json` scenes. Ordinary `.sog` files and `meta.json` use the regular model loader.

- `sogLod.ts` parses manifests and selects LOD targets using `splatBudget`. `SogVisibility` keeps the spatial tree and distance-based priorities in the LOD worker.
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
- `rad_lod.rs` selects a camera-dependent tree cut using file-global node indices. Children replace parents only as complete groups. `radFade.ts` compares selections and prepares transitions in the LOD worker.
- The LOD worker retains each chunk's inverse Morton order and block bounds until chunk release. `prepareRadSelection.ts` builds render indices and merges current/post-fade bounds together; publication and fade completion switch indices and bounds together on the calling thread.
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
- Internal modules import helpers from their owner. `utils/index.ts` is the public entry point.
- Keep scene updates, sorting handoffs, and stochastic transitions in shared rendering code, with backend-specific storage and output handling in each backend.
- Keep options and types beside their owner. Shared uniform defaults must not import backends; native projected-cache layouts belong in `webgpu/`, separately from packed source layouts in `data/`.
- Keep numeric codecs separate from Three.js object unpacking so decode workers avoid scene dependencies.
