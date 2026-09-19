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
| `temporalEnabled` | Enable camera-motion history; default `true` |
| `resetHistory()` | Discard motion history after camera cuts or scene changes and request a redraw |
| `compose(renderer, scene, camera)` | Render to the current target or canvas; render directly when disabled or filtering is unnecessary |
| `dispose()` | Release the pass's resources and binding without disposing the Splat renderer |

## Camera motion

Moving stochastic frames combine spatial filtering with depth-reprojected history, capped at 8 effective samples per pixel. Depth checks reject stale history. Small color excursions outside the current neighborhood range are clamped and gradually reduce history weight; larger excursions reject history. Faster motion also reduces its weight. WebGL and WebGPU support logarithmic depth.

Stochastic coverage uses fixed spatial blue noise, shifted per Splat; the noise does not change each frame.

The 64×64 tile is generated locally by `node scripts/generate-blue-noise.js`. The fixed-seed void-and-cluster generator combines two Gaussian scales to control local clustering and broader density variation. It uses periodic boundaries and assigns each rank from 0 to 4095 exactly once, giving a uniform threshold distribution and spatially dispersed coverage.

The first stochastic frame initializes history. Stationary frames discard it; Auto mode returns to sorted rendering when sorting completes. Each `compose()` call renders the scene once, with no stationary accumulation or extra redraw requests.

Set `temporalEnabled = false` for spatial filtering only. Call `resetHistory()` after camera cuts or scene changes. Size, camera, renderer, projection, and color-configuration changes invalidate history automatically.

The spatial kernel defaults to 4×4 on both backends. Source builds can change `SPATIAL_FILTER_SIZE` in `src/resolve/StochasticResolvePass.ts`.

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
