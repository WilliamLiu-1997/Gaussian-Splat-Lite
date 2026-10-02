# TAAPass

[Back to documentation](../README.md#documentation)

Temporal anti-aliasing for **WebGLRenderer**. Import `TAAPass` from `gaussian-splat-lite`. For **WebGPURenderer**, including its WebGL2 fallback, use the library's [TAANode](#webgpurenderer-tsl-version).

The pass is based on Three.js TRAA and needs no velocity texture. Camera motion is supported; independent object motion and changes to individual Splats are not tracked.

## Constructor

```ts
import { TAAPass } from "gaussian-splat-lite";

const taa = new TAAPass(scene, camera);
```

`scene` is a Three.js `Scene`, and `camera` is a `PerspectiveCamera` or `OrthographicCamera`. The pass renders the scene itself and manages camera jitter internally. It supports one non-XR camera.

## WebGLRenderer setup

This example assumes an existing `renderer`, `scene`, and `camera`. If smoothing [stochastic rendering](StochasticRendering.md), also set `splatRenderer.stochastic = true`. The repository's `examples/viewer/viewerTAA.js` uses this same setup.

```js
import { TAAPass } from "gaussian-splat-lite";

const taa = new TAAPass(scene, camera);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  taa.render(renderer);
});

// On resize: update the renderer size and camera projection.
// On a camera cut or scene replacement: taa.reset().
// On cleanup:
// renderer.setAnimationLoop(null);
// taa.dispose();
```

`TAAPass` renders the scene and presents the result directly; no composer is needed. To add linear effects such as Bloom, see [Color space](#color-space).

The pass follows the canvas size. Call `reset()` after a camera cut or scene replacement; resizing clears history automatically. For on-demand rendering, keep rendering for several frames after each change; the viewer uses 32.

### EffectComposer and offscreen rendering

For a postprocessing chain, add the pass to an `EffectComposer`:

```js
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";

const composer = new EffectComposer(renderer);
composer.addPass(taa);
// Render with composer.render(); update composer.setSize() on resize.
```

`TAAPass` replaces `RenderPass` and follows the composer's size. Its result is ready for display, so do not add `OutputPass` unless using linear effects as described below. Dispose both `taa` and `composer` when finished.

To render offscreen directly, pass a target; the pass follows its size:

```js
taa.render(renderer, target);
```

Without a target, the pass follows the canvas size. Call `taa.dispose()` when finished.

### Color space

By default, `accumulateInOutputSpace = true`: the pass renders and accumulates in `renderer.outputColorSpace`, so Splats look the same as when drawn directly to the canvas. The result is ready for display. Adding `OutputPass` would convert the colors a second time.

For Bloom and other linear effects, set `accumulateInOutputSpace = false` and finish the chain with `OutputPass`:

```js
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

taa.accumulateInOutputSpace = false;
composer.addPass(taa);
// Add Bloom or other linear effects here.
composer.addPass(new OutputPass());
```

In this mode, Splats blend in linear space, which makes partially transparent areas slightly brighter than direct canvas rendering.

### Depth effects

`taa.depthTexture` exposes the current scene capture's depth for subsequent effects. When building the chain, bind it once and run the effect after `TAAPass`:

```js
depthEffect.uniforms.tDepth.value = taa.depthTexture;
depthEffect.uniforms.captureProjection.value = taa.projectionMatrix;

const composer = new EffectComposer(renderer);
composer.addPass(taa);
composer.addPass(depthEffect);
```

Here `depthEffect` is a custom pass that consumes those uniforms. Both objects stay the same across frames and resizes, so bind them once.

The depth is the current frame's raw depth, rendered with camera jitter and not temporally smoothed. Use `taa.projectionMatrix` to decode it, not `camera.projectionMatrix`, which no longer includes the jitter. Treat both as read-only.

## WebGPURenderer TSL version

`TAANode` implements the same camera/depth reprojection, 32-frame Halton jitter, depth rejection, neighborhood clipping, and luminance-aware blending for native WebGPU and WebGPURenderer's WebGL2 fallback. It captures the scene itself and uses two history targets, with no velocity attachment or history copies.

```js
import { TAANode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

const taa = new TAANode(scene, camera);
const pipeline = new RenderPipeline(renderer, taa);
pipeline.render();
// On a camera cut / scene replacement: taa.reset().
// On cleanup: pipeline.dispose(); taa.dispose();
```

Chain TSL effects from the node or `taa.getTextureNode()`. Accumulation stays in the working color space; `RenderPipeline` applies tone mapping and output conversion at the end. `accumulateInOutputSpace` and the classic `Pass` properties apply only to `TAAPass`.

`TAANode` exposes the same `depthThreshold`, `edgeDepthDiff`, `maxMotionLength`, `useSubpixelCorrection`, `depthTexture`, and `projectionMatrix`. Both implementations support one non-XR perspective or orthographic camera, including custom projections, scaled camera rigs, reversed depth, and logarithmic depth. They track camera movement, not independent object motion.

## Properties

| Property | Default | Description |
| --- | --- | --- |
| `scene` | Constructor scene | Scene to render; call `reset()` when replacing it. |
| `camera` | Constructor camera | Camera used for jitter and reprojection; call `reset()` when replacing it. |
| `accumulateInOutputSpace` | `true` | Accumulate in the output color space for direct display. Set `false` for linear effects and finish with `OutputPass`. |
| `depthTexture` | Read-only | Current frame's scene depth. |
| `projectionMatrix` | Read-only | Jittered projection matching `depthTexture`. |
| `depthThreshold` | `0.0005` | Reject non-edge history when the depth difference exceeds this value. |
| `edgeDepthDiff` | `0.001` | Depth range within the 3×3 neighborhood that identifies an edge. |
| `maxMotionLength` | `128` | Camera motion in pixels at which history loses all weight. |
| `useSubpixelCorrection` | `true` | Increase current-frame weight for subpixel camera motion. |

The standard Three.js `Pass` properties, including `enabled` and `renderToScreen`, also apply. `EffectComposer` sets `renderToScreen` for its last enabled pass.

## Methods

| Method | Description |
| --- | --- |
| `setSize(width, height)` | Resize in physical pixels. Called automatically; a size change clears history. |
| `render(renderer, writeBuffer = null)` | Render the scene and resolve TAA to the canvas or a supplied target. Also called by `EffectComposer`. |
| `reset()` | Clear history and restart the jitter sequence. |
| `dispose()` | Release the pass's GPU resources. The scene is not disposed. |
