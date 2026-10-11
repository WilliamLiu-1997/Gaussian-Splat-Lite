# NeuralDenoiseNode

[Back to documentation](../README.md#documentation)

`NeuralDenoiseNode` smooths the noise of [stochastic rendering](StochasticRendering.md) with a small neural network. It takes the place of [`TAANode`](TAAPass.md#taanode-webgpurenderer) on `WebGPURenderer` with native WebGPU, and suits scenes whose objects move: it reduces trails behind them.

## Choose between the two

| | `TAANode` | `NeuralDenoiseNode` |
| --- | --- | --- |
| Moving objects | May leave a faint trail and grainy edges | Rejects stale history to reduce trailing. Moving detail can look softer and grainier until it stops |
| While the camera moves | Some grain returns | Preserves fine detail with less grain. A fast turn still looks softer while it lasts |
| Still image | Smooth | Cleaner, with more fine detail |
| Cost | Lower | More GPU time, and about 2.6–4.4 times the memory depending on profile and sampling |
| Renderer | WebGPU and its WebGL2 fallback | Native WebGPU only |

## Choose a profile

The third constructor argument picks a profile. They trade detail, noise and flicker differently; the preferred result depends on the scene and motion.

| Profile | What you get |
| --- | --- |
| `"profile1"` — Profile 1 | Fixed spatial filtering with lower GPU and memory cost |
| `"profile2"` — Profile 2 (default) | Adaptive spatial filtering and finer decisions at edges, with higher GPU and memory cost |

Compare fine detail, flicker, isolated dots and newly exposed backgrounds in your scenes when choosing between them. The profile numbers do not rank image quality.

The fourth constructor argument, `samples`, chooses coverage quality independently of the profile. Both profiles support both settings:

| Samples | What you get |
| --- | --- |
| `1` (default) | One coverage test per pixel |
| `4` — Quality 4× | Four coverage tests per pixel, each controlling one MSAA sample |

Quality 4× reduces the noise entering the selected profile's filter, which helps where motion leaves little usable history. It renders the scene once per frame into a 4× multisampled scene target. These are coverage samples, not separate shading evaluations or additional scene renders.

Approximate texture memory, including image history and intermediate textures, in addition to the scene's resources:

| Profile | 1× | 4× |
| --- | --- | --- |
| Profile 1 | 95 bytes/pixel; 371 MiB at 2560×1600 | 139 bytes/pixel; 543 MiB at 2560×1600 |
| Profile 2 | 116 bytes/pixel; 453 MiB at 2560×1600 | 160 bytes/pixel; 625 MiB at 2560×1600 |

GPU time depends on the device, scene and image size.

All profiles align history using the camera and depth. They do not track an object's own motion: where an object moves, the network rejects stale history and relies more on the current frame. A newly exposed background needs time to settle. No profile requires a velocity buffer or per-object data.

The profile and sample count are fixed when the node is created. To change either, dispose the node and create another. The viewer offers separate profile and coverage quality controls.

## Before you start

- **Native WebGPU.** After `await renderer.init()`, `renderer.backend.isWebGPUBackend` tells you whether it is in use. On the WebGL2 fallback use `TAANode`, and with `WebGLRenderer` use `TAAPass`.
- **One camera.** A `PerspectiveCamera` or `OrthographicCamera`, including custom projections, scaled camera rigs, reversed depth, and logarithmic depth. WebXR is not supported.
- **Stencil follows your renderer.** Create the Three.js renderer with `stencil: true` and stencil masks work as they do without the node.
- **Reset after a jump.** Call `denoise.reset()` after a camera cut or after replacing the scene. Resizing resets automatically. Objects that move need no call.
- **Keep rendering while the image settles.** A still image keeps getting cleaner for about 130 frames. With on-demand rendering, render that many more after each change. The viewer renders 128.

## Set it up

After `await renderer.init()`, with an existing `renderer`, `scene`, `camera`, and `splatRenderer`:

```js
import { NeuralDenoiseNode, TAANode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

splatRenderer.stochastic = true;

const denoise = renderer.backend.isWebGPUBackend
  ? new NeuralDenoiseNode(scene, camera, "profile1", 4) // Defaults: "profile2", 1.
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

At `samples = 1`, partly transparent Splats look the same whatever Three.js's working color space is, and the same as on `WebGLRenderer`. With four coverage samples, either profile averages them in the working color space before filtering. In the default linear working color space, partly transparent Splats can therefore look brighter than at one sample, as with `TAANode`. In an sRGB working color space, as in the viewer, this transfer difference does not apply. Changing the working color space restarts the smoothing.

## Properties

| Property | Default | Description |
| --- | --- | --- |
| `scene` | Constructor scene | Scene to render; call `reset()` when replacing it |
| `camera` | Constructor camera | Camera to render with; call `reset()` when replacing it |
| `profile` | `"profile2"` | Read-only. The constructor profile: `"profile1"` or `"profile2"` |
| `samples` | `1` | Read-only. Coverage samples per pixel: `1` or `4`, with either profile |
| `depthTexture` | Read-only | Scene depth of the current frame |
| `projectionMatrix` | Read-only | Projection that matches `depthTexture` |
| `stabilize` | `true` | Blends each image with the one before it wherever the network trusts its history. `false` leaves a little more flicker while the image settles |

`depthTexture` is not smoothed, and it is rendered with a small per-frame camera offset, as with `TAANode`. Convert it with `projectionMatrix`, not `camera.projectionMatrix`. Read `depthTexture` once when you build the pipeline: it holds the depth of every frame rendered after that. Treat both as read-only.

At four coverage samples, `depthTexture` holds the nearest covered sample at each pixel. Color can contain contributions from several depths, so this depth describes the closest contributing surface.

## Methods

| Method | Description |
| --- | --- |
| `reset()` | Discard earlier frames and start smoothing again |
| `dispose()` | Release the resources it holds. The scene is not disposed |
| `setSize(width, height)` | Resize in physical pixels. Called for you; a size change resets |
| `getTextureNode()` | The smoothed image, for chaining effects |

## Background

The method follows Hu et al., [Ultra-fast Neural Inference for Stochastic Gaussian Splatting Denoising](https://arxiv.org/abs/2609.25604), adapted to scenes with moving objects and trained on this library's stochastic rendering. The two trained networks are built in; there is nothing to download. Higher coverage sampling reuses the selected profile's network.
