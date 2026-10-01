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

Use Three.js `TRAANode` with WebGPURenderer, or `TAARenderPass` with WebGLRenderer. The examples below assume an existing `renderer`, `scene`, `camera`, and `splatRenderer`, with the Splat renderer already added to the scene. They use the default `autoUpdate = true` and a single non-XR camera.

The noise pattern changes on each render by default so TAA can smooth it over time. The library does not add TAA or schedule these extra renders for you. With on-demand rendering, keep rendering while TAA accumulates.

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
const pipeline = new RenderPipeline(renderer, taa.before(scenePass));

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});
```

Use `taa.before(scenePass)` so the scene renders before TRAA reads its input size and initializes history, including on the first frame and after a resize.

Include the `velocity` output so TRAA can reproject history during movement. Camera movement and `SplatMesh` transforms are supported automatically; changes to individual Splats are not tracked. With `autoUpdate = false`, call `update()` after model changes.

The pass sizes follow the renderer automatically; update the renderer size and camera projection on resize. For on-demand rendering, schedule extra frames after each change; the viewer uses 32. When finished, stop the animation loop and dispose `pipeline`, `taa`, and `scenePass`.

For WebGL2 fallback with `reversedDepthBuffer: true`, also apply the Three.js r186 depth correction in the [viewer example](../examples/viewer/viewerTAA.js). That example includes history reset and on-demand rendering helpers.

### WebGLRenderer: TAA

```js
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { TAARenderPass } from "three/addons/postprocessing/TAARenderPass.js";

splatRenderer.stochastic = true;

const composer = new EffectComposer(renderer);
const taa = new TAARenderPass(scene, camera);
taa.accumulate = true;
taa.sampleLevel = 0;
composer.addPass(taa);

const output = new OutputPass();
composer.addPass(output);

function invalidateTAA() {
  taa.accumulateIndex = -1;
}

renderer.setAnimationLoop(() => {
  // Update controls / animation here. Call invalidateTAA() if the image changes.
  composer.render();
});
```

`TAARenderPass` renders the scene itself, so no separate `RenderPass` is needed. It accumulates 32 samples while the scene is still, without motion reprojection. Call `invalidateTAA()` whenever the camera, model, lighting, or streamed content changes; also connect it to the Splat renderer's `onDirty` callback. For on-demand rendering, continue until `taa.accumulateIndex >= 32` after each invalidation.

On resize, update the renderer and camera, resize the composer, and recreate `TAARenderPass`: Three.js r186 does not resize its hold buffer. When finished, stop the animation loop and dispose `taa`, `output`, and `composer`. See the [viewer example](../examples/viewer/viewerTAA.js) for the resize and cleanup code.

## Control the noise pattern

To keep the noise fixed, or control samples in your own TAA integration:

```js
splatRenderer.autoAdvanceStochasticSample = false;
splatRenderer.stochasticSample = 0; // Keep fixed, or increment it yourself.
```

Set `autoAdvanceStochasticSample = true` to restore automatic updates.

## Return to sorted rendering

```js
splatRenderer.stochastic = false;
```

On WebGL, switching in either direction takes effect once the next update and its sort finish; `stochasticActive` reports whether stochastic rendering is in use. Keep TAA running until it turns `false`. With `autoUpdate = false`, update before drawing:

```js
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```
