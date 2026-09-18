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
| `temporalEnabled` | Enable experimental temporal smoothing in non-XR `compose()`; defaults to `false` |
| `needsHistoryFrame` | Whether temporal warm-up needs another frame; also signaled through the bound renderer's `onDirty` callback |
| `resetHistory()` | Discard accumulated color and request a redraw after a camera cut or scene change |
| `compose(renderer, scene, camera)` | Render the scene to the canvas or XR output, managing the intermediate target when needed. Render directly when resolve is unnecessary |
| `resolve(renderer, inputTarget, outputTarget)` | Process an already-rendered target. Use `null` as the output for the canvas or active XR output |
| `clear` | Clear the resolve output before drawing; defaults to `false` |
| `renderToScreen` | Output to the canvas when used with EffectComposer; defaults to `false` |
| `dispose()` | Release the pass's resources and binding without disposing the Splat renderer |

Reuse the pass when replacing a renderer. Switch before rendering the next frame; the pass keeps its `enabled` state:

```js
resolvePass.splatRenderer = nextRenderer;
```

`compose()` requires the canvas or XR output to be active. For a custom render target, render the scene yourself and use `resolve()`. When the pass is disabled, `compose()` renders directly, explicit `resolve()` calls copy the input, and EffectComposer skips the pass.

## Temporal smoothing

```js
resolvePass.temporalEnabled = true;
```

Temporal smoothing validates history against depth and neighborhood colors on every frame, including when the camera is stationary. Static-camera depth validation compares neighborhood ranges in both frames so random Splat coverage can change the sampled surface without repeatedly clearing valid history. Rejected depth or color restarts accumulation for the affected pixels; valid history elsewhere is retained. The per-pixel sample limits are `MOVING_HISTORY_SAMPLES` during camera movement and `HISTORY_SAMPLES` when stationary. A source marker tracks whether the entire accumulated color contains only Splat samples, including colors mixed by spatial filtering or reprojection. Pure Splat history retains its color at the stationary limit without treating random coverage colors as motion. History containing ordinary geometry or transparent overlays keeps color validation and continues updating at the limit. Neighborhoods without Splat coverage copy the current frame directly, so ordinary grids and meshes do not retain old colors. Stationary frames use unfiltered current samples. Presentation smoothing fades toward its minimum over `HISTORY_TRANSITION_FRAMES` stationary frames and increases locally when a pixel has fewer valid samples.

The internal `SPATIAL_SMOOTHING_MIN_WEIGHT` constant in `StochasticHistory.ts` controls the remaining stationary smoothing, from `0` to `1`. Its default of `0` preserves the full fade-out; `0.25` retains 25% strength, and `1` keeps full smoothing. `SPATIAL_SMOOTHING` still selects the kernel size, and `0` disables spatial filtering regardless of the minimum weight.

This also smooths depth-companion coverage when `autoStochastic` or `renderDepth` is enabled and `depthWrite` is off. In auto mode, stationary accumulation waits for sorting to finish. `compose()` presents current-frame depth alongside accumulated color.

Camera movement shortens history and restarts the presentation transition. Renderer replacement, resizing, projection and output-color changes reset history, and Splat/LOD changes restart stationary averaging. Call `resetHistory()` after camera cuts or abrupt changes to lighting or Splat rendering options. Object motion requires no registration or bounds updates. Depth and color rejection reduce trails, including for transparent objects, but cannot detect every change that remains within the current neighborhood's depth and color range without object motion vectors.

On-demand render loops should honor the bound renderer's `onDirty` callback, or `needsHistoryFrame`, during the `HISTORY_SAMPLES` stationary warm-up frames after initialization, a camera movement, or `resetHistory()`. Automatic redraw requests then stop. Applications still request renders for their own scene changes or animations; every actual `compose()` call validates and updates history, even after warm-up. Use `resetHistory()` when another full warm-up is needed.

Temporal smoothing applies only to non-XR `compose()`. Explicit `resolve()`, EffectComposer, and WebXR keep spatial filtering.

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
resolvePass.resolve(renderer, inputTarget, outputTarget);
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
