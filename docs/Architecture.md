# Architecture

[Back to documentation](../README.md#documentation)

This guide is for contributors. It describes internal module boundaries, backend differences, and resource lifetimes. To use the library, start from the [README](../README.md#quick-start) and the API pages it lists; those pages describe behavior, and this one explains how it is implemented.

[`src/index.ts`](../src/index.ts) defines the public exports. Applications use `SplatMesh` for models and one `GaussianSplatRenderer` for the scene.

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
| `src/rendering/` | Shared updates, sorting handoffs, backend selection, and stochastic blue noise |
| `src/rendering/tsl/` | Shared TSL generation, projection, drawing, and view uniforms |
| `src/rendering/webgpu/` | Compute projection, projected caches, GPU sorting, and indirect drawing |
| `src/rendering/webgl/` | GLSL materials, texture generation, and CPU ordering uploads |
| `src/rendering/webgl-fallback/` | WebGPURenderer WebGL2 raster generation and ordering uploads |
| `src/plugins/` | Optional renderer plugins, published through the separate `gaussian-splat-lite/plugins` entry |
| `src/plugins/lighting/` | Lighting plugin: light records, lit shader variants, shadow map lookups, and shadow casters |
| `src/capture/` | Optional offscreen targets, readback, cube captures, and PMREM filtering |
| `src/addons/` | Temporal anti-aliasing: `TAAPass` for WebGLRenderer, `TAANode` for WebGPURenderer, and their shared state |

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

In `webgpu/`, `ProjectedSplats.ts` coordinates projection and sorting, `ProjectionCache.ts` owns projected storage, and `RadixSort.ts` owns sort passes. WebXR uses the eyes' mean pose for generation and sorting, with separate projections for each eye. Both WebGL backends share `webgl/OrderingTexture.ts` for allocation and disposal, while keeping their own upload and binding paths.

`backend.ts` selects the backend from the renderer type and its public `coordinateSystem`, which distinguishes native WebGPU from WebGL fallback. It chooses the blend space for each output: the working color space by default, `renderer.outputColorSpace` when WebGLRenderer draws to the canvas, and the target texture's color space when it draws to an XR-style target.

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

Coverage uses a tileable 32-frame spatiotemporal blue-noise atlas (`blueNoise.ts`, generated by `scripts/generate-blue-noise.js`) on all backends. Each Splat keeps its own spatial offset and temporal phase, so consecutive samples follow the atlas's time axis instead of choosing unrelated offsets. The temporal sequence is optimized for exponential history accumulation and wraps after 32 samples. `stochasticSample` advances once per scene render, and every view in that render shares it.

Seeds exist only for stochastic draws: WebGL accumulators omit the seed layer in sorted rendering, and native WebGPU allocates its seed buffer on demand. Front-to-back stochastic ordering uses 16-bit keys. With unsorted stochastic rendering, `shrinkResources()` releases the sort worker and ordering.

### Lighting and shadows

[Lighting](Lighting.md) is an optional `SplatLightingPlugin` in `src/plugins/lighting/`, imported from `gaussian-splat-lite/plugins` and installed with `registerPlugin()`. The root package exports the generic plugin interface without importing lighting or shadows. Each plugin owns its state, materials, scene hooks, and resources; unregistering it releases them. Unlit draws use their usual materials and projection program.

The renderer exposes generic extension points: projection program outputs, node shading, GLSL shader includes, material selection, and render lifecycle hooks. Native WebGPU accepts a `ProjectionCacheExtension` through `WebGPUSplatBackend.setProjectionExtension()` and `ProjectedSplats.setExtension()`. An extension supplies a projection program and optional packed records beside the usual projected data; `ProjectedVertexData.record` carries those records to a material. Lighting implements this contract with its surface cache, so the core has no lighting-specific storage, uniforms, or compute branch.

Lit Splats shade themselves. From Three.js they take what it documents: each light's properties and its `shadow.map`, `shadow.matrix`, and `shadow.camera`. They use none of its light uniforms, shader chunks, or light nodes, so a Three.js release that changes those does not reach them.

- **Lights.** `SceneLights` lists a render's lights as Three.js does, visible and on the camera's layers, and writes them as `vec4` records for each view: colors with intensity, ranges, cones, and positions and directions in that view's own space. The CPU composes them in double precision, so coordinates far from the origin stay exact, and each WebXR eye has its own block. Splats draw in a view space that keeps a camera rig's scale; a block carries the world length of a view unit, because lights fall off over world lengths.
- **Surface.** Projection adds a view-space normal, the Gaussian's shortest axis turned toward the viewer, and the gradient of expected view depth across the footprint, from the covariance of depth with screen position. With the plugin's model light flags they form one flat `uvec4` (`tsl/surface.ts`): a varying on the WebGL backends, where flags come from a texture with one texel per accumulator row (`LightFlags.ts`), and a record of `SurfaceCache` on native WebGPU. The fragment stage moves each fragment along its view ray to that depth and evaluates Lambert diffuse there in linear color: `webgl/lighting.glsl` and `tsl/shading.ts` hold the same math. `ModelLighting` stores model settings in a plugin-owned `WeakMap`; group settings apply to descendant models, including streamed batches created later.
- **Shadow lookups.** `describeShadowMap` is the one place that knows how the renderers store a map, read from the map itself where it says so. A depth texture with a comparison function is sampled through its sampler, once or with five turned taps on a disk, the filter Three.js gives meshes. WebGLRenderer's unfiltered maps hold plain depth. A point light's map is a cube around the light. Variance maps differ: WebGLRenderer blurs depth into the map's color texture, which Splats read; WebGPURenderer keeps its blurred copy to itself, so `VarianceMap` blurs the light's depth map the same way, over `shadow.radius` in `shadow.blurSamples` steps, before each lit draw and after Three.js has drawn the depth map; switching lighting off frees it. Depth and its comparison follow the renderer's reversed and logarithmic depth settings. Each lookup goes through a view-to-shadow matrix, `shadow.matrix` times the view's world matrix, composed on the CPU.
- **Shader variants.** A lit shader is generated for the lights' layout: their kinds in order, and what each shadow map holds. `WebGLLitMaterial` puts the surface and lighting code in place of the shaders' two includes and regenerates it when the layout changes, within the draw: WebGLRenderer has drawn the render's shadow maps by then. On WebGPURenderer a map is drawn only for a material Three.js lights, so `LitSplatNodeMaterial` is such a material. Its lighting model adds no color: setting up each light's own shadowed color is what makes the renderer draw that light's map ahead of the Splats, whatever the draw order, and rebuild the shader as lights change. The shading is generated in that build, for the lights and maps of the moment, and loads its uniforms in the material's own update, after the maps are drawn. The material's cache key advances whenever the scene's lights change, in which there are or which cast: Three.js keeps a shader for each list of lights it has drawn, and one kept from before would still update shadow maps released since. The key follows every visible light, not the ones a camera's layers select, so cameras that see different lights of one scene add no rebuild of their own.
- **Casters.** `SplatShadows` keeps one `ShadowDraw` per casting model as a child of the renderer; all of a renderer's casters share one material, whose uniforms each caster sets before its shadow draw. The first shadow view prepares each model's source textures and transforms once per scene render; other lights and cube faces reuse them, while cached maps skip preparation. Each shadow view has its own draw origin, as the main Splat draw has its camera: a perspective shadow camera's position, and for an orthographic one the middle of its depth range, since a directional light can sit far from what it lights. Source offsets and each shadow view's transform are composed in CPU double precision before uploading origin-relative float32 values. Only the source translation changes between shadow views; moving the color camera alone leaves shadow casting unchanged. A caster draws its model's source records directly into each shadow map, with no accumulator, ordering, bounding-box culling, or per-light cache: the shared generation and projection programs in TSL, and `shadowVertex.glsl` over the `splatSource` chunk in GLSL. Each caster vertex checks its center against the shadow view before decoding shape and color or applying SDF edits, then applies alpha and projected-footprint checks. A streamed scene casts through its batches, whose shadow settings the plugin resolves from the stream group's configuration. Coverage is the stochastic draw's, with one fixed noise slice per Splat so shadows do not flicker. Depth follows each Gaussian's covariance plane, after SuperSplat's Popless projection, with W kept fixed so depth stays affine across the quad and is clipped by hardware. In color renders a caster draws nothing: WebGPURenderer leaves it out of their lists, and WebGLRenderer lists it with a material that stands in for the caster's. Casters are made for a render in which some light casts shadows and hidden in others; switching lighting off takes them out of the scene and keeps their material compiled.
- **Frame order.** Casters read models directly, so a render's update must come before its shadow maps, which Three.js can draw before any object's `onBeforeRender`. While lighting is on, `SplatLightingPlugin` follows the scene's `onBeforeRender` and `onAfterRender` (`sceneHook.ts`): as a render begins it lists the lights, readies the shader, and runs the renderer's draw preparation; the draw's own `onBeforeRender` then continues the same frame. A render with `scene.overrideMaterial` set is an auxiliary pass, as WebGPURenderer's shadow passes are. It begins no frame, its lists include the casters, and lit Splats do not receive shadows in it, so they neither ask for a shadow map from inside a shadow pass nor draw into a variance map as receivers.
- **Depth conventions.** The node casters write logarithmic depth when the renderer uses it, and the node lookups compare in it. WebGLRenderer compares shadow maps in projective depth even then, so the GLSL caster always writes that.
- **WebXR.** Shadow maps are drawn once per render, before the eyes. WebGLRenderer draws each eye separately, with that eye's light block. On the node backends one draw covers both eyes and indexes the blocks by eye.
- **TSL.** A node read in several branches must be a variable set before them: TSL computes a shared node where a shader first needs it twice, and a later branch then reads a temporary only a sibling branch assigned. The native kernel copies its lighting switch this way, and the lit shader the flag that says whether a Splat receives shadows.

`CSMShadowNode` receivers read each cascade's public light, shadow map and split range, including fading, and compose each view-to-shadow matrix on the CPU as for ordinary maps. The node is recognized by those fields, not by its class, so the library imports no addon for it and an application's own copy of the addon works. Other custom `shadow.shadowNode` implementations render and sample elsewhere and do not shadow Splats, though Splats cast into them. On WebGPURenderer, transmitted shadows read the map's color texture as well as depth and combine its color and alpha with the filtered visibility and shadow intensity. All backends add shadow bias with regular depth and subtract it with reversed depth, including WebGLRenderer's directional and spot PCF lookups.

## Capture boundaries

[SplatCapture](SplatCapture.md) is optional; the core renderer allocates no capture resources.

- **Independent Splat state.** The helper owns an internal `GaussianSplatRenderer` with `autoUpdate` and stochastic rendering off, sharing the display renderer's timer, loaded Splat data, and model-owned SDF edit textures. Its accumulators, sorting, and projection resources are separate, so display ordering and camera state are untouched. Global and model-local edits apply to captures and follow their latest values. `frameCallbacks` is off, leaving `onFrame` to the display renderer.
- **Stencil captures.** 2D and cube targets follow the Three.js renderer's stencil setting, with no separate capture option; a 2D target without a depth buffer gets no stencil, since Three.js attaches stencil only with depth. The intermediate target uses a depth-stencil attachment when stencil is enabled. With stencil, native depth is 32-bit float only for a reversed depth buffer or a float output depth texture, and only when the device has `depth32float-stencil8`; otherwise it is 24-bit. The scene's stencil masking applies before copying its color and depth to the output.
- **Options.** Quality, sorting, and material options are copied from the supplied renderer at the start of each capture. The active Splat material's stencil comparison and write settings are copied as well. Optional plugins are cloned for the capture renderer through the generic plugin interface; lighting clones share model settings while keeping their rendering resources separate. Cube captures force radial sorting. The internal renderer takes the capture camera's layer mask.
- **Two phases.** Preparation awaits `update()` on a filtered scene view (`sceneView.ts`), which excludes hidden models from traversal without changing visibility and collects edits with the original scene's visibility. If the display updates shared models during a pending sort, preparation runs again; appearance-only changes reuse the ordering. The draw is synchronous: other Splat renderers' layer masks are cleared, `hideObjects` are hidden, and the internal renderer joins the scene. `withCaptureState()` saves and restores the render target, cube face, mip level, XR setting, automatic clearing, and MRT. Nothing stays changed across an `await`, and everything is restored when drawing throws.
- **Ordering.** Captures on one helper are queued and run in call order. The camera or `worldCenter` is copied when the call is made. `renderReadTarget()` and `renderEnvMap()` read or filter inside the same queued task, before a later capture can redraw the target.
- **Cube captures.** Splat data is prepared at `worldCenter` with a 90° camera, then six faces render with automatic updates off. Both WebGL backends share one radial CPU sort across the faces; native WebGPU projects, compacts, and sorts for each face while drawing. Every capture runs `update()`, whose version checks reuse valid data and ordering, so 1.1.8's `update` option is not offered. Mipmaps are generated after the sixth face. Filtered and unfiltered cubes use separate targets, reallocated when size, clipping planes, or the renderer's stencil setting change.
- **Color.** `WebGLCapture` renders into an intermediate flagged as an XR-style target, 8-bit unless the output is float, so materials convert to the output color space before blending as on the canvas; a full-screen pass then converts to the target's storage space and copies depth. `WebGPUCapture` renders in the working color space, then applies the renderer's output transform and converts to storage space. On both, float outputs keep their type so values stay unclamped, and the intermediate takes the output's sample count, so multisampling applies to the scene and not to the final pass.
- **Readback.** `pixels.ts` returns packed RGBA8 with the bottom row first on every backend, removing native WebGPU's 256-byte row padding and flipping its top-left origin. Supersampled targets are box-filtered on the CPU. Cube faces are normalized to the WebGL cube render target layout: native WebGPU stores +X and −X swapped and reads each face rotated 180°.
- **Ownership.** `dispose()` releases the internal renderer, 2D and cube targets, readback buffers, and the PMREM generator. Each texture from `renderEnvMap()` belongs to the caller; disposing it also releases its PMREM render target.

## Temporal anti-aliasing boundaries

[TAAPass and TAANode](TAAPass.md) are derived from Three.js TRAA, without a velocity attachment: reprojection uses scene depth and camera motion only, so object motion is not tracked.

- `taaShared.ts` owns the state both share: a 32-entry Halton(2, 3) jitter sequence, jittered and unjittered projections, previous-frame matrices, the history index, sizing, and reset. It supports custom projections, scaled rigs, reversed depth, and logarithmic depth.
- Each implementation captures the scene itself into a half-float target with a depth texture and resolves between two history targets, with no history copies. The resolve applies depth rejection away from edges, neighborhood clipping, and luminance-aware blending.
- The capture target takes a stencil buffer when the Three.js renderer has one; the history targets never do, since the resolve writes only color and depth. Depth stays 32-bit float, except in `TAANode` on the WebGL2 fallback or on a device without `depth32float-stencil8`, where it is 24-bit.
- The camera's projection is jittered only during capture. Native Splat projection reads the unjittered matrix through `getTAAProjection()`, so projection and sorting results are reused while only the jitter changes.
- `TAAPass` flags its capture target as an XR-style target, so Three.js converts materials to `renderer.outputColorSpace` before blending, matching canvas blending. Tone mapping is disabled during capture. The final copy decodes the sRGB transfer into the composer's working-space buffer, the inverse of `OutputPass`, so the two round-trip at any alpha; as the last pass it presents the output-space image unchanged. An output color space change resets history.
- `TAANode` is a TSL node updated once per render. It captures and accumulates in `ColorManagement.workingColorSpace`, leaving tone mapping and output conversion to `RenderPipeline`. A working color space change resets history.

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
| `optimizer.ts` | Fusion of single-use arithmetic intermediates before compilation |
| `compiler.ts` | Conditional flow, dependencies, packed instructions, and attribute snapshots |
| `registers.ts` | Runtime register allocation and values carried between condition stages |
| `operations.ts` / `runtime.ts` | Packed input reads, block execution, conditions, and output writes |

Decode workers import runtime and protocol modules directly, keeping expression construction and compilation outside their dependency graph.

## Shared streaming boundaries

Loaders own transport and parsing; schedulers own selection, fades, publication, and retirement.

- `StreamWorkerPool.run()` queues worker leases, assigns task IDs, links cancellation, counts downloads, and balances loading-manager notifications. Each loader has its own pool; format-specific callbacks retain SOG caches or release RAD decoder slots.
- `IndexedSplats` shares texture storage and selected-index reads between `RadPagedSplats` and `SogRegionSplats`. Slot assignment and scene attachment remain with the format-specific scheduler and batch classes.
- `StreamCameras.ts` owns the registered cameras and their resolutions, and expands a WebXR `ArrayCamera` into its eye views once they have a projection and viewport.
- `streamOptions.ts` owns shared defaults, validation, retry classification, and statistics. `StreamByteBudget` bounds pending copies separately from active loads; ready data has no per-update byte allowance.

`splatBudget` controls selected detail, not total memory. Resident-byte estimates exclude pending copies and WASM memory, which are reported separately; resident storage has no byte cap. Pending copies allow 8 MiB per concurrent load (32 MiB by default), enlarged for an indivisible RAD page; one oversized item can proceed alone. This bounds the waiting queue, not the bytes published or uploaded per frame.

Applications must keep calling `update()` while waiting for `firstRenderable` and while loading, fades, retries, or retirement need to advance. `onChange` requests redraws; it does not drive scheduler updates. Schedulers update ordinary camera matrices, but read a WebXR camera's eye matrices directly and select detail for each eye. Streaming updates before rendering may use the previous frame's XR pose.

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
- Keep scene updates and sorting handoffs in shared rendering code, with backend-specific storage and output handling in each backend.
- Keep options and types beside their owner. Shared uniform defaults must not import backends; native projected-cache layouts belong in `webgpu/`, separately from packed source layouts in `data/`.
- Keep numeric codecs separate from Three.js object unpacking so decode workers avoid scene dependencies.
