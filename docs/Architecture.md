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
| `src/capture/` | Optional offscreen targets, readback, cube captures, and PMREM filtering |
| `src/addons/` | Smoothing for stochastic rendering: `TAAPass` for WebGLRenderer, `TAANode` and `NeuralDenoiseNode` for WebGPURenderer, and their shared state |

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

## Capture boundaries

[SplatCapture](SplatCapture.md) is optional; the core renderer allocates no capture resources.

- **Independent Splat state.** The helper owns an internal `GaussianSplatRenderer` with `autoUpdate` and stochastic rendering off, sharing the display renderer's timer, loaded Splat data, and model-owned SDF edit textures. Its accumulators, sorting, and projection resources are separate, so display ordering and camera state are untouched. Global and model-local edits apply to captures and follow their latest values. `frameCallbacks` is off, leaving `onFrame` to the display renderer.
- **Stencil captures.** 2D and cube targets follow the Three.js renderer's stencil setting, with no separate capture option; a 2D target without a depth buffer gets no stencil, since Three.js attaches stencil only with depth. The intermediate target uses a depth-stencil attachment when stencil is enabled. With stencil, native depth is 32-bit float only for a reversed depth buffer or a float output depth texture, and only when the device has `depth32float-stencil8`; otherwise it is 24-bit. The scene's stencil masking applies before copying its color and depth to the output.
- **Options.** Quality, sorting, and material options are copied from the supplied renderer at the start of each capture. The active Splat material's stencil comparison and write settings are copied as well. Cube captures force radial sorting. The internal renderer takes the capture camera's layer mask.
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

## Neural denoiser boundaries

[NeuralDenoiseNode](NeuralDenoiseNode.md) follows Hu et al., "Ultra-fast Neural Inference for Stochastic Gaussian Splatting Denoising" (arXiv 2609.25604), in its form without per-Gaussian parameters. The authors published no code or weights; the three models in `neuralDenoiseWeights.ts`, one per quality level and between 650 and 3,600 parameters each, were trained on this renderer's stochastic frames, with a moving camera and moving objects.

- **Structure.** Two running means per pixel: an accumulated path over raw frames, which converges to the blended image, and a denoised path over spatially filtered frames, which covers short histories. One small network predicts how far to trust each path's reprojected history. A gate mixes the paths by the accumulated path's history length and the standard error of its mean, and a stabilization pass blends the result with the previous image inside the range of the current 3x3 neighbourhood.
- **Departures from the paper,** each for content that moves without motion vectors. Reprojection uses the third nearest depth of the 3x3 neighbourhood, because stochastic depth is the depth of whichever layer survived and jumps between layers. A slow low-pass luma, accumulated with the accumulated path's weights, feeds the network: against the current filtered frame it shows slow motion that single noisy frames hide. The difference between the two is also kept per block, with its sign, as running means over about 3, 6, 12 and 24 frames (see Still views below). Four inputs compare chroma: every other cue is a luma difference or a depth mismatch, so a translucent tinted object that writes no depth changed neither and left its tint in the accumulated path. The stabilization blend, the accumulated path's share of the gate and the spatial filter's strength are predicted rather than fixed. The network runs on 2x2 blocks at half resolution and its output is upsampled.
- **Motion following.** Reprojection knows the camera, not what objects do, so moving content has no usable history at `"performance"`: it is free of trails and soft. The other two levels measure motion from the images. Per block, a least-squares fit (Lucas and Kanade) over a window of about sixteen pixels gives the shift between the frame and the previous displayed image, with the frame's sub-pixel jitter taken out first. One frame's shift is noisy, so it is kept as a running mean that is also averaged over the window every frame, and it is held towards no motion with a small weight, or an estimate would stay for good where the image has no detail. A second network of 49 parameters turns the estimate's size, the share of the frame difference it has been removing, its disagreement with the frame at hand and its own previous answer into a probability that following is right. Above a threshold every pass that reprojects reads history at the shifted position; following half way would be right nowhere. Two things switch it off whatever the probability: an estimate that has not been removing a real share of the difference, which is what a still view looks like, and a block where nothing has a depth. Nothing comes from the renderer or the application for this: no velocity attachment, no object matrices.
- **Why the two networks are separate.** The trust network does not see the motion measurements. It did in a first version, and learned to keep history wherever the estimate was large and explained much. The measurements cannot bear that: they are taken over a window, so beside a moving edge they describe the edge and not the still content next to it, and on a still view they are noise. Still views flickered three times as much and what a moving object had just left was 2 dB worse, and hiding the inputs from that trained network brought both back. Kept apart, a wrong decision to follow costs what any wrong read of history costs, and where nothing is followed the trust network decides as it would without following. The `"balanced"` model's trust network was trained without following; the second network was added to it and trained alone.
- **Limits of following.** One shift per block: where layers at different depths move differently behind each other, no single shift is right and nothing is gained. The fit captures a few pixels per frame; faster content is not followed. Coarser levels of the images and larger steps converge sooner and end up worse, because one frame's large step is mostly wrong. A learned decision cannot tell still detail right beside a moving edge from detail that moves, since the measurements it sees mix the two; such detail is softer for a few frames.
- **Quality levels.** `"performance"` is the eight-channel trust network in a shorter pipeline of its own, without following (see Lean pipeline). `"balanced"` is a network of that size in the full pipeline, on 2x2 blocks, with motion following. `"quality"` has sixteen hidden channels and one residual block between the network's two stages, was trained together with following, and filters each frame with a learned filter where the other two use a fixed kernel (see Learned filter and Wider comparisons). The larger network alone measured 0.1 to 0.5 dB better than `"balanced"` on moving content and the same on still views, and widening the network without following measured no gain at all: what limits the image is the two paths and what reprojection can align, not the trust network's capacity.
- **Lean pipeline.** Measured pass by pass, the full pipeline without following spent a fifth of its time on the view depth, two fifths on two passes over every pixel with four half-float targets each (one reprojects, one updates), three tenths on the network at half resolution, and a tenth on stabilization. `"performance"` keeps what the image is made of, both running means, the gate and stabilization, and takes the rest more coarsely. The view depth is kept per 2x2 block. The network runs on 4x4 blocks and takes a block's means directly: of the history from four bilinear taps into the previous frame's state at where the block was, so nothing reprojected is stored for it; of the frame from the image pyramid; of the filtered frame from thirteen bilinear taps into the pyramid, which give that mean exactly because the kernel is linear. One pass per pixel then reprojects, filters, updates both paths, mixes them and stabilizes. Stabilizing in that pass means its tolerance cannot come from the current result's neighbourhood, which is not in a texture yet. It comes from what the previous image spans across the five taps it is resampled with, and on every test set the two measured the same. Against the same network in the full pipeline it adds half the time to a frame (see Cost), measures within 0.2 dB on every test set, and flickers less on still views, because a 4x4 block's statistics carry half the noise of a 2x2 block's. While the camera moves it keeps about a tenth less fine detail, since history is dropped a 4x4 block at a time. The network has to be given the block's mean of the filtered frame, not only of the frame. The filter moves light across a block's border, so beside a thin bright edge the two differ for good. A first version compared a block's own colour with its filtered history, read that difference as lasting change, and a still view of such an edge flickered three times as much.
- **Learned filter.** At `"quality"` a network of 1,136 parameters predicts a 3x3 kernel for every pixel, at three levels of the frame's image pyramid and then at full resolution. Each level filters itself and decides per pixel how much of that to keep over the level below. A level's network sees its colour, the result from below, how far the four finer pixels of each of its pixels are from their mean (the noise at that scale), and the hidden channels of the level below. A kernel is nine weights that sum to one, so the filter only ever averages the frame: it cannot invent content, and since it reads nothing but the frame it cannot leave a trail. It was trained alone first, single frames against converged references (28.8 dB where the fixed kernel reaches 27.8 dB), then together with the trust network. Wider versions measured the same alone, and one of 80,000 parameters 0.4 dB more. Against the same level with the fixed kernel, PSNR rises by 0.6 dB while the camera moves, 0.3 dB on still views and behind glass, and 0.2 dB on sequences with moving objects; where the image has just changed it measures the same. The image is cleaner rather than sharper: its fine detail has the same amplitude and follows the reference more closely (correlation 0.63 against 0.60).
- **Wider comparisons.** With the learned filter, what the trust network compares had to widen. The fixed kernel spreads every pixel over its neighbours, so a 2x2 block's mean of the filtered frame was a statistic over about 4x4 pixels. The learned filter keeps a thin edge thin and its noise with it: where a model's outline lies against the empty background, a different part of the outline's Splats is lit in every frame. A block's filtered luma then moved half as much again from frame to frame, the network read that as change, and a still view of such an outline flickered four times as much. So at this level the filtered frame, the denoised history and the slow luma are compared as means over the 4x4 pixels around a block. Of fifteen still views fourteen then flicker less than with the fixed kernel, most by a third to a half. One flickers more, the far edge of a floor against the empty background (0.013 against 0.011), and training further on such views made it worse, not better.
- **Sizes.** Each level of the image pyramid, and each halving of the motion fit's sums, takes the mean of 2x2 and leaves an odd last row or column out, so a pixel of any level covers whole pixels of the frame counted from the top-left corner, and the pyramid is read at positions in pixels of the frame. That is what the reference model does. A first version of the shaders stretched each level over the whole frame instead, which is the same only at sizes that are multiples of eight: at 515x323 its displayed image was 0.012 from the reference on average and its motion estimate 0.28 pixels, where they are 0.0002 and 0.0006 now, as at multiples of eight.
- **Passes.** `NeuralDenoiseNode` is a TSL node like `TAANode` and reuses `taaShared.ts` for jitter, sizing, stencil and reset. It captures the scene into a half-float target, then runs fragment passes written in WGSL (`neuralDenoiseShaders.ts`, weights inlined as constants) directly on Three's `GPUDevice`, outside the node system, and exposes the last pass's target as its texture: seven at `"performance"`, only one of them at full resolution; sixteen at `"balanced"`, where the eight that following adds run at half resolution or below; and twenty-six at `"quality"`, whose network has one more and whose learned filter takes nine, eight of them at half resolution or below. A working color space with a linear transfer adds one. No pass has more than four half-float attachments, the default limit, which is why a network's sixteen channels are four textures.
- **Still views.** On strongly noisy content, such as a half-transparent bright layer over a dark one, one frame cannot tell slow motion from noise: a still block looks changed every few frames. A model that reacts to single frames keeps dropping the accumulated history there and shows the fallback, which flickers in patches; trained not to react, it smears slow motion instead. The running means of the signed difference separate the two, because noise changes sign and averages out while a change that lasts does not. They store the difference only, never image content, so reprojection under camera motion blurs noise away instead of inventing edges, and they fade with the trust of the history they describe. Training has to match: gradients run through time, since dropping a still pixel's history costs the frames after it rather than the frame at hand, and still views are held to zero change with the worst pixels counted separately.
- **State.** Kept from frame to frame in pairs that alternate between read and write: both means, one texture with the second moment of luma, both history lengths and the slow luma, the predicted trust and the evidence means at half resolution, the view depth, the displayed image, and with following the motion estimate at half resolution. At `"performance"` the view depth is at half resolution and trust and evidence at a quarter. With the scratch textures of one frame that is about 93 bytes per pixel at `"performance"`, 165 at `"balanced"` and 186 at `"quality"`, against 36 for `TAANode`.
- **Half-float rounding.** Metal truncates a float written to a half-float target. A 128-frame running mean then loses half a unit in the last place on every write and ran 3% dark after 200 frames. At start the node draws a value between two halves and reads back which one was stored; where the GPU truncates, every pass adds half a unit before writing.
- **Color.** The networks were trained on display-referred values. In a working color space with a linear transfer, one more pass encodes the scene with the sRGB transfer on the way in (on the unpremultiplied color) and the output node decodes it, so partly transparent Splats resolve on display values in every working space. A working color space change resets history.
- **Cost.** On an Apple M5 Pro, whole frames of the example scene at 1280x800 and 2560x1600: the scene alone takes 3.3 ms and 6.4 ms, `TAANode` 3.5 ms and 7.0 ms, `"performance"` 3.7 ms and 7.9 ms, `"balanced"` 4.2 ms and 10.0 ms, and `"quality"` 4.7 ms and 11.7 ms. These are medians; a second scene gave the same differences within 0.3 ms. The same network as `"performance"` in the full pipeline took 4.1 ms and 9.6 ms. Following costs little because its eight passes run at half resolution or below. The wider network costs more because each of its layers writes four textures instead of two, and the learned filter adds 0.2 ms and 0.6 ms. In the full pipeline reprojection, the update and stabilization run at full resolution and take most of the time. What remains at `"performance"` is its one pass per pixel, and about 0.5 ms at the larger size for sampling the scene's depth at all, however few reads the pass makes.
- **Testing.** The shaders were checked against a PyTorch reference of the same pipelines, texture by texture over recorded sequences, at every level and at two sizes, 512x320 and 515x323; the displayed image differs by 0.0003 or less on average and the motion estimate by about 0.001 pixels. Flicker was measured in the viewer as the mean change between consecutive frames of a still view, per pixel: across six close-up views of one scene at most 0.01% of pixels change by more than 0.03 at any level, where `TAANode` leaves 2 to 21%. On recorded sequences of a turning model, against a converged reference of every frame, following raises PSNR where the image changes by 0.9 to 1.9 dB, a deforming model included. It lowers PSNR in what a moving box left behind: by up to 0.4 dB right after it has passed, and in one of twelve sequences by 1.8 dB in the area it left 16 to 24 frames earlier. Behind glass, where two layers shift at different rates as the camera moves and reprojection can follow only one, no level does better than another by more than 0.3 dB, and training on such views changed nothing. That reference and the training harness are not part of this repository.

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
