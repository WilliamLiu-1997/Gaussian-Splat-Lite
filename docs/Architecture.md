# Source architecture

[Back to documentation](../README.md#documentation)

`src/index.ts` defines the public exports. Shared code is grouped by responsibility; graphics backends live under `rendering/`.

| Directory | Responsibility |
| --- | --- |
| `src/data/` | Packed Splat data, codecs, texture layout and CPU unpacking |
| `src/scene/` | Scene objects, mesh transforms, raycasting and SDF edits |
| `src/loaders/` | File loading, decode requests and post-decode expression programs |
| `src/loaders/rad/` | RAD source reads and container types |
| `src/loaders/sog/` | SOG source reads and ZIP access |
| `src/loaders/stream/` | Shared workers, budgets, options and statistics |
| `src/loaders/stream/rad-stream/` | RAD loading, tree selection and page pools |
| `src/loaders/stream/sog-stream/` | SOG loading, visibility, chunk caches and regions |
| `rust/gaussian-splat-lib/src/` | Platform-independent PLY/SPZ/SOG/RAD decoders, `SplatReceiver` and packed codecs |
| `rust/gaussian-splat-rs/src/` | WASM bridges, `SplatsData` output arrays, sorting and raycasting |
| `src/runtime/` | Worker RPC, pooling, transferable discovery and WebAssembly initialization |
| `src/utils/` | Numeric conversion, spatial transforms, Three.js helpers and the public utility namespace |
| `src/rendering/` | Shared renderer, accumulator, sort cache, stochastic resolve and backend selection |
| `src/rendering/webgl/` | GLSL materials, array-target generation, ordering textures, uploads and readback |
| `src/rendering/tsl/` | Shared TSL generation, projection, draw and resolve programs, view uniforms, node materials and readback |
| `src/rendering/webgpu/` | Native compute projection, projection caches, GPU sorting and indirect drawing |
| `src/rendering/webgl-fallback/` | WebGPURenderer WebGL2 raster generation and integer ordering textures |

## Rendering boundaries

| Owner | Responsibility |
| --- | --- |
| `GaussianSplatRenderer` | Updates, accumulator handoff, sorting, stochastic state, and companion depth |
| `SplatAccumulator` | Scene mappings, versions, camera-relative data, and WebGL texture generation |
| `StochasticResolvePass` | Scene composition, XR eye atlas, and renderer-state restoration |
| WebGL backend | GLSL materials, ordering textures, array-target generation, readback, and PMREM |
| WebGPU backend | Compute projection, caches, GPU sorting and indirect drawing |
| WebGL fallback backend | Raster generation and CPU-sorted ordering textures |
| Shared TSL code | Splat/resolve materials, generation math, output handling, readback and PMREM |

The backend is selected at construction after `WebGPURenderer.init()`. Renderer identity selects the material API; the actual backend selects compute/storage or raster/textures. Both WebGL backends use asynchronous Worker/WASM sorting; native WebGPU sorts on the GPU before drawing.

Resource rules:

- Keep native ordering and visible counts on the GPU; worker ordering belongs to the WebGL backends.
- Wait for outstanding GPU compilation before disposing the sorter.
- Preserve WebGPU compute nodes when resizing buffers and textures or adding and removing source meshes.
- Keep backend-specific color and XR output handling with each backend.

Shared TSL shaders live in `tsl/`: `GenerateProgram.ts` and `ProjectionProgram.ts` (generation and projection), `SplatMaterial.ts` and `ResolveMaterial.ts` (drawing and resolve), `viewUniforms.ts` (view data), and `shaderUtils.ts` (helpers). WebGL shaders live under `webgl/shaders/`.

In `webgpu/`, `ProjectedSplats.ts` coordinates projection and sorting; `ProjectionCache.ts` owns projected textures and encoding; `RadixSort.ts` owns the sort passes.

## Decoder boundaries

PLY, SPZ, SOG and RAD decode in `gaussian-splat-lib` and publish through `SplatReceiver`. The core library does not depend on JavaScript or WASM. `gaussian-splat-rs` adapts browser inputs and writes the receiver output into JS typed arrays through `SplatsData`.

- PLY/SPZ consume byte streams with their existing `ChunkReceiver` interface.
- `SogDecoder<T>` reads external property images in groups and publishes bounded batches into its receiver. Metadata parsing, ZIP payload checks, image decoding and SH palette handling live in the core library. `SogDecodeSession` only bridges the grouped API to JavaScript.
- RAD retains its dataset codebooks between page requests. Each page decodes into a `SplatReceiver` and returns separate page/tree metadata for LOD scheduling.
- `SplatReceiver.set_sh_palette()` has a native fallback through the SH band setters. `SplatsData` overrides it to copy packed palette words directly, preserving SOG's compact palette and avoiding a full float SH expansion.

`RadSource` and `SogSource` share byte reads, request settings and cancellation through `loaders/source.ts`. `sogZip.ts` handles ZIP access; ordinary loaders coordinate prefetch, decoding and assembly.

## Shared streaming boundaries

Loaders own transport and parsing; schedulers own selection, fades, publication and retirement.

- `StreamWorkerPool` manages bounded worker leases, cancellation and cache lifetime. Workers transfer owned `SplatResult` arrays to batch sources.
- `IndexedSplats` shares textures, selected-index reads and upload accounting between `RadPagedSplats` and `SogRegionSplats`. Batches manage slots and scene attachment.
- `streamOptions.ts` shares defaults, validation and statistics. `StreamByteBudget` limits pending copies and per-update uploads separately from active loads.

`StreamStats` reports active loads, pending copies, resident CPU/GPU storage, downloaded bytes and WASM peaks. Resident bytes exclude pending copies and WASM memory; resident storage has no byte cap.

## Streamed SOG boundaries

`SogStreamScheduler.update()` coordinates selection, region transitions, cache release, and loading. Region transitions run in order: advance fades, update visibility, attach ready regions, queue extractions, and finish immediate fades.

- `sogLod.ts` owns manifest parsing, budget selection, and progressive LOD resolution. LOD decisions do not depend on workers or GPU resources.
- `SogVisibility` collects visible leaves and their coverage weights.
- `SogStreamLoader` loads and parses the index, then owns decoding workers and cached chunk sources.
- `SogStreamBatch` owns occupied slots and mesh attachment based on region opacity. `SogRegionSplats` owns its indexed GPU data in `data/`.
- `SogStreamScheduler` keeps each leaf's target, current region, outgoing region and pending extraction together. It owns region fades, retirement, upload limits and retries.

SOG images and RAD pages share the optional `resolveFile` input contract in `loadTypes.ts`. Ordinary loading bridges resolver requests to the main thread through the existing worker RPC; caller-owned buffers are copied before transfer. Packed SOG assets bypass the resolver.

## RAD boundaries

- `rust/gaussian-splat-lib/src/rad.rs` validates and decodes version 1 containers and properties. `gaussian-splat-rs/src/rad.rs` exposes typed WASM output in the renderer's native packed format.
- `loaders/rad.ts` assembles ordinary files, validates the complete tree and extracts leaves before `postDecode`.
- `RadSource` owns bounded local/HTTP reads, Range consistency, relative page resolution and cancellation.
- `RadStreamLoader` owns a bounded pool of decoding workers, defaulting to four. Each owns its decoder and codebooks; the first worker also owns the complete LOD tree. Other workers transfer compact tree arrays to it before publishing geometry. A retained encoded root seeds shared SH codebooks without repeated downloads. Page retirement releases geometry and tree data; decode generations prevent stale cancellation from releasing a replacement page.
- `radLod.ts` selects a camera-dependent tree cut in the worker with a priority heap, hysteresis and strict Splat/page budgets. Children replace a parent only as a complete group. Selection uses file-global node indices, never texture slots.
- `radFade.ts` compares cuts, identifies changed pages and merges transitions in the LOD worker. The scheduler maps sorted page ranges into affected pools only; unchanged pools and incoming-only fade completion preserve their index and sort data.
- `RadStreamScheduler` owns page requests, publication, LOD crossfades, retirement and retry policy. Incoming and outgoing nodes fade while shared nodes render once at full opacity; at most two cuts overlap. In-flight selection snapshots and fading nodes pin their resident pages. Root and traversal ancestors remain available for coarsening.
- `RadPagedSplats` and `RadStreamBatch` own fixed page slots and compact selected indices. CPU transitions update the same opacity table used by SOG, retaining index textures and sort data during fades. Texture pools are allocated on demand. Unused pages retire after fade-out and `cooldownTicks` updates, and empty pools release their storage.

`SplatOpacityTable` stores one 32-bit opacity per source block in a single-channel texture array. Its layers follow the packed source layers, so opacity-only changes upload only affected layers. `sourceBlockBits` is `6` for SOG allocation blocks, `0` for individual RAD nodes, and `32` when disabled. Both backends share this lookup; fade progress and transition kinds remain on the CPU.

See [RAD loading and streaming](RadStreamScheduler.md) for options and public lifecycle guarantees.

## Imports and extensions

- Applications import from `gaussian-splat-lite`, including `utils` and `defines`. Source paths are internal.
- Internal modules import helpers from their owner; `utils/index.ts` is the public entry only.
- Keep scene updates, sorting handoffs, and stochastic transitions in shared rendering code.
- Keep options, types, and small helpers beside their owner. TSL types belong in `tsl/`.
- Shared uniform defaults must not import backends. Native projected-cache layout belongs in `webgpu/`, separately from packed source layout in `data/`.
- Separate numeric codecs from Three.js object unpacking so decode workers avoid scene dependencies.
