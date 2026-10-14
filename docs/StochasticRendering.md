# Stochastic rendering

[Back to documentation](../README.md#documentation)

Stochastic rendering is an optional way for `GaussianSplatRenderer` to draw transparency. It produces visible noise, so pair it with temporal anti-aliasing (TAA) or the experimental neural denoiser to get a smooth image. Sorted alpha blending remains the default.

Stochastic rendering works on WebGPU, WebGL2, and `WebGPURenderer`'s WebGL2 fallback, including WebXR. The smoothing options below do not support WebXR.

## Turn it on

With an existing [GaussianSplatRenderer](GaussianSplatRenderer.md):

```js
splatRenderer.stochastic = true;
```

Splats are sorted from front to back by default. To skip this sorting:

```js
splatRenderer.stochasticSort = false;
```

Both can be changed at any time. While stochastic rendering is active, Splats are drawn without blending and with depth testing and depth writing on. Your `transparent`, `depthTest`, and `depthWrite` settings apply again when you return to sorted rendering.

## Smooth the noise

Use [`TAANode`](TAAPass.md#taanode-webgpurenderer) with `WebGPURenderer`, or [`TAAPass`](TAAPass.md#taapass-webglrenderer) with `WebGLRenderer`. The [experimental neural denoiser](NeuralDenoiseNode.md) is an alternative for scenes with moving objects on all three backends. The library does not turn any of them on for you. The examples assume an existing `renderer`, `scene`, `camera`, and `splatRenderer`, with one camera outside WebXR.

### WebGPURenderer: TAANode

Use this on both WebGPU and the WebGL2 fallback, after `await renderer.init()`:

```js
import { TAANode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

splatRenderer.stochastic = true;

const taa = new TAANode(scene, camera);
// Chain Bloom or other effects from taa here.
const pipeline = new RenderPipeline(renderer, taa);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});
```

### WebGPURenderer: NeuralDenoiseNode

To help reduce trails behind moving objects, replace `TAANode` in the setup above with `NeuralDenoiseNode`:

```js
import { NeuralDenoiseNode } from "gaussian-splat-lite";

const denoise = new NeuralDenoiseNode(scene, camera);
const pipeline = new RenderPipeline(renderer, denoise);
```

It also supports the WebGL2 fallback. See [Neural denoising](NeuralDenoiseNode.md) for modes, MSAA and WebGL2 requirements.

### WebGLRenderer: TAAPass

```js
import { TAAPass } from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

splatRenderer.stochastic = true;

const taa = new TAAPass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(taa);
// Insert Bloom or other effects here.
composer.addPass(new OutputPass());

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  composer.render();
});
```

`TAAPass` takes the place of `RenderPass`. On resize, call `composer.setSize(width, height)` along with the renderer.

### WebGLRenderer: NeuralDenoisePass

Replace `TAAPass` in the composer setup above with `NeuralDenoisePass`, keeping `OutputPass` after it:

```js
import { NeuralDenoisePass } from "gaussian-splat-lite";

const denoise = new NeuralDenoisePass(scene, camera);
composer.addPass(denoise);
```

It has the same options and requirements as `NeuralDenoiseNode` on WebGL2.

### With any of these

- Call `reset()` after a camera cut or a scene replacement. With TAA, also call it after an abrupt change to an object: TAA follows camera movement, not moving objects.
- With on-demand rendering, keep rendering for several frames after the camera, a model, or streamed content changes, and after the Splat renderer's `onDirty` callback, so the noise can settle. The viewer renders 32 with TAA and 128 with the neural denoiser.

See [TAAPass and TAANode](TAAPass.md) and [Neural denoising](NeuralDenoiseNode.md) for effects, depth, color, and cleanup. The repository's `examples/viewer/viewerTAA.js` supports all three backends.

## Control the noise pattern

The noise pattern changes on every render so TAA or neural denoising can smooth it over time. To keep it fixed, or to control it from your own render loop:

```js
splatRenderer.autoAdvanceStochasticSample = false;
splatRenderer.stochasticSample = 0; // Keep fixed, or increase it yourself.
```

When you advance it yourself, increase it by one for each render of the scene. The patterns repeat every 32 samples; a smooth image is not guaranteed after exactly 32 renders. Set `autoAdvanceStochasticSample = true` to hand control back.

## Return to sorted rendering

```js
splatRenderer.stochastic = false;
```

The switch, in either direction, takes effect on a later frame rather than immediately. `stochasticActive` tells you which mode is being drawn; keep your TAA or neural denoiser running until it is `false`. With `autoUpdate = false`, update before drawing:

```js
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```

If you keep TAA or neural denoising running with sorted rendering, set `splatRenderer.depthWrite = true` so it can use the Splats' depth.
