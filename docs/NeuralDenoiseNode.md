# NeuralDenoiseNode

[Back to documentation](../README.md#documentation)

`NeuralDenoiseNode` smooths the noise of [stochastic rendering](StochasticRendering.md) with a small neural network. It takes the place of [`TAANode`](TAAPass.md#taanode-webgpurenderer) on `WebGPURenderer` with native WebGPU, and suits scenes whose objects move: it leaves no trail behind them.

## Choose between the two

| | `TAANode` | `NeuralDenoiseNode` |
| --- | --- | --- |
| Moving objects | May leave a faint trail and grainy edges | No trail. Detail stays sharper while it moves slowly enough to follow, and looks softer when it moves faster |
| While the camera moves | Some grain returns | Stays smooth |
| Still image | Smooth | Smooth, with a little more fine detail |
| Cost | Lower | More GPU time, and four to five times the memory |
| Renderer | WebGPU and its WebGL2 fallback | Native WebGPU only |

## Choose a quality level

The third constructor argument picks one of three levels. Each step up takes more GPU time.

| Level | What you get | Added per frame over `TAANode`, 1280×800 / 2560×1600 |
| --- | --- | --- |
| `"performance"` | No trail behind moving objects. Whatever moves looks soft until it stops | 0.7 ms / 2.9 ms |
| `"balanced"` (default) | Also follows content that moves, such as a model that turns or deforms: its detail stays sharper and its noise settles while it moves | 0.9 ms / 3.2 ms |
| `"quality"` | Balanced with a larger network. Slightly cleaner around moving objects; the difference is small | 1.1 ms / 4.3 ms |

Times are from an Apple M5 Pro.

Following needs no setup: the node measures motion from the image itself, with no velocity buffer and no per-object data. It has limits. Content that moves by more than a few pixels per frame is not followed, and neither are places where layers at different depths move in different directions behind each other. Both look as they do at `"performance"`. Right beside something that moves, still detail can look a little softer for a moment.

The level is fixed when the node is created. To change it, dispose the node and create another.

## Before you start

- **Native WebGPU.** After `await renderer.init()`, `renderer.backend.isWebGPUBackend` tells you whether it is in use. On the WebGL2 fallback use `TAANode`, and with `WebGLRenderer` use `TAAPass`.
- **One camera.** A `PerspectiveCamera` or `OrthographicCamera`, including custom projections, scaled camera rigs, reversed depth, and logarithmic depth. WebXR is not supported.
- **Stencil follows your renderer.** Create the Three.js renderer with `stencil: true` and stencil masks work as they do without the node.
- **Reset after a jump.** Call `denoise.reset()` after a camera cut or after replacing the scene. Resizing resets automatically. Objects that move need no call.
- **Keep rendering while the image settles.** With on-demand rendering, render about a hundred more frames after each change. The viewer renders 96.

## Set it up

After `await renderer.init()`, with an existing `renderer`, `scene`, `camera`, and `splatRenderer`:

```js
import { NeuralDenoiseNode, TAANode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

splatRenderer.stochastic = true;

const denoise = renderer.backend.isWebGPUBackend
  ? new NeuralDenoiseNode(scene, camera) // or (scene, camera, "performance")
  : new TAANode(scene, camera);
const pipeline = new RenderPipeline(renderer, denoise);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});

// On a camera cut or scene replacement: denoise.reset().
// On cleanup: pipeline.dispose(); denoise.dispose();
```

The pipeline follows the renderer's size by itself. The node renders the scene itself and needs no velocity buffer or other scene setup.

Chain effects from the node or from `denoise.getTextureNode()`. For Bloom, create the pipeline like this instead:

```js
import { bloom } from "three/addons/tsl/display/BloomNode.js";

const color = denoise.getTextureNode();
const pipeline = new RenderPipeline(renderer, color.add(bloom(color, 0.6, 0.4, 0.8)));
```

## Color

`RenderPipeline` applies tone mapping and the output color space at the end, as it does for `TAANode`.

Partly transparent Splats look the same whatever Three.js's working color space is, and the same as on `WebGLRenderer`. With `TAANode` and the default linear working color space they look slightly brighter. Changing the working color space restarts the smoothing.

## Properties

| Property | Default | Description |
| --- | --- | --- |
| `scene` | Constructor scene | Scene to render; call `reset()` when replacing it |
| `camera` | Constructor camera | Camera to render with; call `reset()` when replacing it |
| `quality` | `"balanced"` | Read-only. The level given to the constructor: `"performance"`, `"balanced"`, or `"quality"` |
| `depthTexture` | Read-only | Scene depth of the current frame |
| `projectionMatrix` | Read-only | Projection that matches `depthTexture` |
| `stabilize` | `true` | Blends each image with the one before it wherever that leaves no trail. `false` leaves a little more flicker while the image settles |

`depthTexture` is not smoothed, and it is rendered with a small per-frame camera offset. Convert it with `projectionMatrix`, not `camera.projectionMatrix`. Treat both as read-only.

## Methods

| Method | Description |
| --- | --- |
| `reset()` | Discard earlier frames and start smoothing again |
| `dispose()` | Release the resources it holds. The scene is not disposed |
| `setSize(width, height)` | Resize in physical pixels. Called for you; a size change resets |
| `getTextureNode()` | The smoothed image, for chaining effects |

## Background

The method follows Hu et al., [Ultra-fast Neural Inference for Stochastic Gaussian Splatting Denoising](https://arxiv.org/abs/2609.25604), adapted to scenes with moving objects and trained on this library's stochastic rendering. The networks for all three levels are built in; there is nothing to download.
