# StochasticResolvePass

[Back to documentation](../README.md#documentation)

`StochasticResolvePass` reduces stochastic noise on WebGL or WebGPU. It binds to one [GaussianSplatRenderer](GaussianSplatRenderer.md) at a time; enable stochastic rendering on that renderer separately:

```js
import { StochasticResolvePass } from "gaussian-splat-lite";

splatRenderer.autoStochastic = true;
const resolvePass = new StochasticResolvePass(splatRenderer);
renderer.setAnimationLoop(() => resolvePass.compose(renderer, scene, camera));
```

## Properties and methods

| API | Description |
| --- | --- |
| `splatRenderer` | Bound Splat renderer; assign another renderer to switch the binding |
| `enabled` | Enable noise reduction; defaults to `true`. Does not change the renderer's stochastic mode |
| `compose(renderer, scene, camera)` | Render the scene to the current target, managing the intermediate target when needed. Render directly when resolve is unnecessary |
| `resolve(renderer, inputTarget, outputTarget = null)` | Process an already-rendered target. Defaults to the canvas or active XR output |
| `clear` | Clear the resolve output before drawing; defaults to `false` |
| `renderToScreen` | Output to the canvas when used with EffectComposer; defaults to `false` |
| `dispose()` | Release the pass's resources and binding without disposing the Splat renderer |

Reuse the pass when replacing a renderer. Switch before rendering the next frame; the pass keeps its `enabled` state:

```js
resolvePass.splatRenderer = nextRenderer;
```

When the pass is disabled, `compose()` renders directly, explicit `resolve()` calls copy the input, and EffectComposer skips the pass.

## EffectComposer

With a WebGL `EffectComposer` (non-XR), add the pass after scene rendering:

```js
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

composer.addPass(new RenderPass(scene, camera));
composer.addPass(resolvePass);
composer.addPass(new OutputPass());
renderer.setAnimationLoop(() => composer.render());
```

## Custom post-processing

```js
renderer.setRenderTarget(inputTarget);
renderer.render(scene, camera);
renderer.setRenderTarget(null);
resolvePass.resolve(renderer, inputTarget);
```

Use a `HalfFloatType` or `FloatType` input after the complete scene render, including the bound Splat renderer. Input and output must use different textures. Outside XR, input dimensions must match the output target, or the canvas drawing buffer when output is `null`. For XR output, use the eye layout described below. Call `dispose()` when finished.

## WebXR

Use the same `compose()` loop with manual stochastic rendering:

```js
splatRenderer.autoStochastic = false;
splatRenderer.stochastic = true;
```

Use `compose()` to handle both eyes automatically. Disabling the resolve pass leaves the original stochastic noise visible.

For a custom XR render graph using `resolve()`:

- Restore the XR output target before calling `resolve(renderer, input, null)`.
- Pack eyes horizontally without gaps in `renderer.xr.getCamera().cameras` order, with eye-local viewports at y = 0. Input width is the sum of eye widths; height is their maximum.
- Attach a `DepthTexture` to the input to copy scene depth when the XR output has a depth buffer.

Disabling manual `stochastic` waits for a sorted replacement when `autoUpdate` is enabled.
