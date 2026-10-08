# TAAPass and TAANode

[Back to documentation](../README.md#documentation)

Temporal anti-aliasing (TAA) blends each frame with the ones before it. It smooths edges and the noise of [stochastic rendering](StochasticRendering.md). Use the version that matches your renderer:

| Renderer | Use |
| --- | --- |
| `WebGLRenderer` | [`TAAPass`](#taapass-webglrenderer) with `EffectComposer` |
| `WebGPURenderer`, on WebGPU or its WebGL2 fallback | [`TAANode`](#taanode-webgpurenderer) with `RenderPipeline` |

Both render the scene themselves and need no velocity buffer or other scene setup.

## Before you start

- **One camera.** A `PerspectiveCamera` or `OrthographicCamera`, including custom projections, scaled camera rigs, reversed depth, and logarithmic depth. WebXR is not supported.
- **Camera movement only.** Moving objects and changes to individual Splats are not tracked, and may leave a faint trail. On native WebGPU, [`NeuralDenoiseNode`](NeuralDenoiseNode.md) is an alternative that leaves none.
- **Stencil follows your renderer.** Create the Three.js renderer with `stencil: true` and stencil masks work as they do without TAA, including the stencil settings on your Splat renderer's `material`.
- **Reset after a jump.** Call `taa.reset()` after a camera cut or after replacing the scene. Resizing resets automatically.
- **Keep rendering while the image settles.** With on-demand rendering, render several more frames after each change. The viewer renders 32.

## TAAPass (WebGLRenderer)

This example assumes an existing `renderer`, `scene`, and `camera`. `TAAPass` takes the place of `RenderPass`, and Three.js's `OutputPass` finishes the image for display.

```js
import { TAAPass } from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const taa = new TAAPass(scene, camera);
const output = new OutputPass();
const composer = new EffectComposer(renderer);
composer.addPass(taa);
composer.addPass(output);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  composer.render();
});

// On resize: update the renderer size and camera projection,
// then call composer.setSize(width, height) in CSS pixels.
// On a camera cut or scene replacement: taa.reset().
// On cleanup:
// renderer.setAnimationLoop(null);
// composer.dispose();
// output.dispose();
// taa.dispose();
```

Dispose the passes as well as the composer when you are done. The repository's `examples/viewer/viewerTAA.js` uses this setup.

### Add effects

Insert Bloom and similar effects between `TAAPass` and `OutputPass`:

```js
import { Vector2 } from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const bloom = new UnrealBloomPass(
  renderer.getSize(new Vector2()), 0.6, 0.4, 0.8,
);
composer.insertPass(bloom, 1);
// On cleanup: bloom.dispose().
```

The order is `TAAPass → effects → OutputPass`. Effects work on the smoothed image.

### Use depth in effects

`taa.depthTexture` gives later effects the scene depth of the current frame. Set it up once when building the chain:

```js
depthEffect.uniforms.tDepth.value = taa.depthTexture;
depthEffect.uniforms.captureProjection.value = taa.projectionMatrix;

const composer = new EffectComposer(renderer);
composer.addPass(taa);
composer.addPass(depthEffect);
composer.addPass(new OutputPass());
```

Here `depthEffect` is your own pass that reads those uniforms. Both objects stay the same across frames and resizes.

This depth is not smoothed, and it is rendered with a small per-frame camera offset. Convert it with `taa.projectionMatrix`, not `camera.projectionMatrix`. Treat both as read-only.

### Render to your own target

To get the smoothed image offscreen, pass a render target; the pass follows the target's size:

```js
taa.render(renderer, target);
```

The result is in the working color space, without tone mapping. Calling `taa.render(renderer)` without a target is not supported; use `EffectComposer` to draw to the screen.

## TAANode (WebGPURenderer)

Use this setup on both WebGPU and the WebGL2 fallback, after `await renderer.init()`:

```js
import { TAANode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

const taa = new TAANode(scene, camera);
const pipeline = new RenderPipeline(renderer, taa);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});

// On a camera cut or scene replacement: taa.reset().
// On cleanup: pipeline.dispose(); taa.dispose();
```

The pipeline follows the renderer's size by itself.

Chain effects from the node or from `taa.getTextureNode()`. For Bloom, create the pipeline like this instead:

```js
import { bloom } from "three/addons/tsl/display/BloomNode.js";

const color = taa.getTextureNode();
const pipeline = new RenderPipeline(renderer, color.add(bloom(color, 0.6, 0.4, 0.8)));
```

`TAANode` has the same `depthTexture`, `projectionMatrix`, and tuning properties as `TAAPass`.

## Color and tone mapping

**`TAAPass`** shows Splats with the same colors as `WebGLRenderer` drawing straight to the canvas.

- `OutputPass` applies the renderer's tone mapping and exposure to the whole image, Splats included. Drawing straight to the canvas does not tone-map Splats.
- If `TAAPass` is the last enabled pass, it shows its image as it is, without tone mapping.
- On a transparent canvas, tone mapping and effects are approximate where pixels are partly transparent. Opaque pixels are unaffected.

**`TAANode`** follows `WebGPURenderer`'s color handling: `RenderPipeline` applies tone mapping and the output color space at the end. With Three.js's default linear working color space, partly transparent Splats look slightly brighter than on `WebGLRenderer`.

Both keep colors brighter than white, so effects such as Bloom work as expected. Changing the renderer's output color space with `TAAPass`, or Three.js's working color space with `TAANode`, restarts the smoothing.

## Properties

| Property | Default | Description |
| --- | --- | --- |
| `scene` | Constructor scene | Scene to render; call `reset()` when replacing it |
| `camera` | Constructor camera | Camera to render with; call `reset()` when replacing it |
| `depthTexture` | Read-only | Scene depth of the current frame |
| `projectionMatrix` | Read-only | Projection that matches `depthTexture` |
| `depthThreshold` | `0.0005` | Depth change above which a pixel's earlier frames are discarded |
| `edgeDepthDiff` | `0.001` | Depth difference between neighboring pixels that marks an edge. Edges are exempt from `depthThreshold` |
| `maxMotionLength` | `128` | Camera movement, in pixels, at which earlier frames are ignored entirely |
| `useSubpixelCorrection` | `true` | Give the current frame more weight during very small camera movements |

The defaults suit most scenes. `TAAPass` also has the standard Three.js `Pass` properties.

## Methods

| Method | Description |
| --- | --- |
| `reset()` | Discard earlier frames and start smoothing again |
| `dispose()` | Release the resources it holds. The scene is not disposed |
| `setSize(width, height)` | Resize in physical pixels. Called for you; a size change resets |
| `render(renderer, target)` | `TAAPass` only. Called for you by `EffectComposer` |
| `getTextureNode()` | `TAANode` only. The smoothed image, for chaining effects |
