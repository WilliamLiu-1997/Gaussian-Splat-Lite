# StochasticTAAPass

[Back to documentation](../README.md#documentation)

Reduces stochastic noise across frames for one [GaussianSplatRenderer](GaussianSplatRenderer.md). Supports WebGL, WebGPU, and WebGPURenderer's WebGL2 fallback.

```js
import { StochasticTAAPass } from "gaussian-splat-lite";

splatRenderer.autoStochastic = true;
const taa = new StochasticTAAPass(splatRenderer);
renderer.setAnimationLoop(() => taa.compose(renderer, scene, camera));
```

Use this pass instead of [StochasticResolvePass](StochasticResolvePass.md) for temporal anti-aliasing. Only stochastic Splats and their immediate edges are filtered; the camera's view offset and `splatRenderer.renderDepth` stay unchanged.

## Properties and methods

| API | Description |
| --- | --- |
| `splatRenderer` | Bound renderer; assigning another renderer discards history |
| `enabled` | Default `true`; disabling draws directly without TAA |
| `compose(renderer, scene, camera)` | Render to the current target or canvas and selectively apply TAA |
| `resetHistory()` | Discard history after camera cuts, model edits, or scene changes |
| `requestRender()` | Schedule 8 more stochastic samples without discarding history |
| `needsRender` | Whether an on-demand loop should keep drawing |
| `dispose()` | Release targets, materials, and the binding |

## Frame history

While the pass is enabled, sorted frames display immediately and refresh history for the next camera movement. This adds offscreen capture work even on sorted frames. Starting directly in manual stochastic mode builds history from noisy frames.

Accumulation uses up to 8 effective samples. Motion reduces history influence, and pixels with rejected history start accumulating again.

For on-demand rendering, call `requestRender()` after scene/camera updates and keep drawing while `needsRender` is true. This schedules up to 8 more frames. Auto mode stops accumulation when sorting completes; manual stochastic mode can accumulate while stationary.

Call `resetHistory()` after camera cuts, object movement, or model edits. View, size, scene, renderer, and color-configuration changes reset history automatically. Some noise, softened detail, or ghosting can remain, and switching to sorted rendering may still be visible.

## Render targets and depth

`compose()` writes to the current render target or canvas. Targets with `depthBuffer` also receive the current scene depth for later geometry to depth-test against. Canvas output does not receive scene depth; include depth-tested geometry in the composed scene.

## EffectComposer

For WebGL post-processing (non-XR), compose into `composer.readBuffer` first:

```js
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const composer = new EffectComposer(renderer);
// Add post-processing effects here, before OutputPass.
composer.addPass(new OutputPass());

renderer.setAnimationLoop(() => {
  renderer.setRenderTarget(composer.readBuffer);
  taa.compose(renderer, scene, camera);
  renderer.setRenderTarget(null);
  composer.render();
});
```

Keep only post-processing passes in the composer; omit `RenderPass` and `StochasticTAAPass`. Read `composer.readBuffer` each frame because the buffers swap.

## ArrayCamera and WebXR

Each view has independent history. For WebXR, use the same `compose()` loop with manual stochastic mode:

```js
splatRenderer.autoStochastic = false;
splatRenderer.stochastic = true;
```

Memory and rendering work increase with the number and resolution of views.
