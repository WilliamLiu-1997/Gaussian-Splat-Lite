# Stochastic rendering

[Back to documentation](../README.md#documentation)

Stochastic rendering is an optional mode for `GaussianSplatRenderer`. It produces visible noise; use temporal anti-aliasing (TAA) to smooth the result. Sorted alpha blending remains the default.

Supported on WebGPU, WebGL2, and WebGPURenderer's WebGL2 fallback, including WebXR.

## Enable stochastic rendering

With an existing [GaussianSplatRenderer](GaussianSplatRenderer.md):

```js
splatRenderer.stochastic = true;
```

Splats are sorted from front to back by default. To skip this sorting:

```js
splatRenderer.stochasticSort = false;
```

Both options can be changed at runtime. While stochastic rendering is active, transparent blending is disabled and depth testing and writing are enabled. Your `transparent`, `depthTest`, and `depthWrite` settings take effect again when you return to sorted rendering.

## Smooth the noise

Use the library's [TAAPass](TAAPass.md) with **WebGLRenderer**, or Three.js **TRAANode** with **WebGPURenderer** (including its WebGL2 fallback). The examples below assume an existing `renderer`, `scene`, `camera`, and `splatRenderer`, with the Splat renderer already added to the scene. They use the default `autoUpdate = true` and a single non-XR camera.

The noise pattern changes on each render by default so TAA can smooth it over time. The library does not enable TAA or schedule these extra renders for you. With on-demand rendering, keep rendering while TAA accumulates.

WebGPURenderer blends in Three.js's linear working color space, which makes partially transparent Splats slightly brighter than WebGLRenderer drawing directly to the canvas. `TAAPass` matches direct canvas rendering by default; see [TAAPass color space](TAAPass.md#color-space).

### WebGPURenderer: TRAA

Use this setup for both native WebGPU and WebGPURenderer's WebGL2 fallback, after `await renderer.init()`:

```js
import { RenderPipeline } from "three/webgpu";
import { mrt, output, pass, velocity } from "three/tsl";
import { traa } from "three/addons/tsl/display/TRAANode.js";

splatRenderer.stochastic = true;

const scenePass = pass(scene, camera, { samples: 0 });
scenePass.setMRT(mrt({ output, velocity }));

const taa = traa(
  scenePass.getTextureNode(),
  scenePass.getTextureNode("depth"),
  scenePass.getTextureNode("velocity"),
  camera,
);
const taaColor = taa.before(scenePass);
// Chain Bloom or other linear effects from taaColor here.
// RenderPipeline applies the final tone mapping and output conversion.
const pipeline = new RenderPipeline(renderer, taaColor);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});
```

Use `taa.before(scenePass)` so the scene renders before TRAA on every frame. `RenderPipeline` converts the final colors for display; no `OutputPass` is needed.

Include the `velocity` output so TRAA can reproject history during movement. Camera movement and `SplatMesh` transforms are supported automatically; changes to individual Splats are not tracked. With `autoUpdate = false`, call `update()` after model changes.

The passes follow the renderer size automatically. When finished, stop the animation loop and dispose `pipeline`, `taa`, and `scenePass`.

### WebGLRenderer: TAAPass

```js
import { TAAPass } from "gaussian-splat-lite";

splatRenderer.stochastic = true;

const taa = new TAAPass(scene, camera);
renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  taa.render(renderer);
});
```

`TAAPass` renders the scene itself, so no `RenderPass` or `OutputPass` is needed. It tracks camera movement but not object motion; call `taa.reset()` after a camera cut or scene replacement. See [TAAPass](TAAPass.md) for linear effects, depth effects, and offscreen rendering.

For on-demand rendering with either setup, keep rendering for several frames after camera, model, or streamed-content changes, including the Splat renderer's `onDirty` callback; the viewer uses 32. The repository's `examples/viewer/viewerTAA.js` shows both setups.

## Control the noise pattern

To keep the noise fixed, or control samples in your own TAA integration:

```js
splatRenderer.autoAdvanceStochasticSample = false;
splatRenderer.stochasticSample = 0; // Keep fixed, or increment it yourself.
```

Set `autoAdvanceStochasticSample = true` to restore automatic updates.

Coverage uses a 32-frame spatiotemporal blue-noise sequence on all backends.
Each Splat keeps its own spatial offset and temporal phase, so consecutive
samples follow the texture's time axis instead of choosing unrelated offsets.
The temporal sequence is optimized for exponential history accumulation.
The sequence wraps after 32 samples; this reduces temporal sampling error but
does not guarantee a noise-free result after 32 renders. Keep advancing the
sample once per scene render, including when using camera jitter.

## Return to sorted rendering

```js
splatRenderer.stochastic = false;
```

On WebGL, switching in either direction takes effect once the next update and its sort finish; `stochasticActive` reports whether stochastic rendering is in use. Keep TAA running until it turns `false`. With `autoUpdate = false`, update before drawing:

```js
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```

If you keep TAA running with sorted rendering, set `splatRenderer.depthWrite = true` so TAA can see Splat depth.
