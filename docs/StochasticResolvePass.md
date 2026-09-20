# StochasticResolvePass

[Back to documentation](../README.md#documentation)

Reduces stochastic noise on WebGL and WebGPU for one [GaussianSplatRenderer](GaussianSplatRenderer.md):

```js
import { StochasticResolvePass } from "gaussian-splat-lite";

splatRenderer.autoStochastic = true;
const resolvePass = new StochasticResolvePass(splatRenderer);
renderer.setAnimationLoop(() => resolvePass.compose(renderer, scene, camera));
```

## Properties and methods

| API | Description |
| --- | --- |
| `splatRenderer` | Assign another renderer to switch the binding; preserves `enabled` |
| `enabled` | Enable noise reduction; default `true`. Does not change stochastic mode |
| `temporalEnabled` | Enable camera-motion history and Auto sorted-frame capture; default `true` |
| `resetHistory()` | Discard motion history after camera cuts or scene changes and request a redraw |
| `compose(renderer, scene, camera)` | Render to the current target or canvas; render directly when disabled or filtering is unnecessary |
| `dispose()` | Release the pass's resources and binding without disposing the Splat renderer |

## Camera motion

Moving stochastic frames combine spatial smoothing with up to 8 effective history samples. Stationary frames use spatial smoothing only, without accumulation or extra redraws. For temporal anti-aliasing that also accumulates while stationary, use [StochasticTAAPass](StochasticTAAPass.md) instead.

In Auto mode, sorted frames display immediately and refresh history for the next camera movement. This adds offscreen capture work and can produce small differences from direct canvas rendering. The pass does not change `splatRenderer.renderDepth`.

Set `temporalEnabled = false` for spatial smoothing only, without sorted-frame capture. Call `resetHistory()` after camera cuts or scene edits; moving or transparent objects can otherwise leave stale color. Scene, size, camera, renderer, projection, and color-configuration changes reset history automatically.

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
  resolvePass.compose(renderer, scene, camera);
  renderer.setRenderTarget(null);
  composer.render();
});
```

Keep only post-processing passes in the composer; omit `RenderPass` and `StochasticResolvePass`. Read `composer.readBuffer` each frame because the buffers swap.

## WebXR

Use the same `compose()` loop with manual stochastic mode. Both eyes have independent motion history:

```js
splatRenderer.autoStochastic = false;
splatRenderer.stochastic = true;
```

Disabling manual `stochastic` waits for a sorted replacement when `autoUpdate` is enabled.
