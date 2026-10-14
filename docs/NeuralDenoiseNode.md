# NeuralDenoiseNode and NeuralDenoisePass (Experimental)

[Back to documentation](../README.md#documentation)

The experimental neural denoiser smooths [stochastic rendering](StochasticRendering.md). Use `NeuralDenoiseNode` with `WebGPURenderer`, including its WebGL2 fallback, or `NeuralDenoisePass` with `WebGLRenderer`. The trained models are included; no extra downloads are needed.

## Choose between TAA and neural denoising

| | `TAANode` / `TAAPass` | `NeuralDenoiseNode` / `NeuralDenoisePass` |
| --- | --- | --- |
| Moving objects | May leave a faint trail | Helps reduce trails; moving detail can still look soft or grainy |
| Camera movement | Some grain returns | Smooths noise during movement; fast turns can look softer |
| Cost | Lower | Depends on mode; Quality uses more GPU time and memory |

With neural denoising, newly exposed backgrounds need time to settle. Results vary by scene and motion.

## Choose a mode

The third constructor argument, `mode`, selects the balance of image quality and cost. Start with the default, then compare detail, noise and flicker in your scenes.

| Mode | What you get |
| --- | --- |
| `"quality"` (default) | Prioritizes noise suppression and detail retention, with higher GPU and memory use |
| `"performance"` | Prioritizes lower GPU and memory use |

```js
const denoise = new NeuralDenoiseNode(scene, camera, "performance");
// NeuralDenoisePass accepts the same arguments.
```

To change modes, dispose the node or pass and create another. The viewer's **Neural mode** selector offers **Performance** and **Quality**.

For existing code, replace `"profile2"` with `"quality"`, `profile` with `mode`, and `NeuralDenoiseProfile` with `NeuralDenoiseMode`. `"profile1"` is no longer supported.

## MSAA

The fourth constructor argument, `msaa`, enables or disables 4× MSAA in either mode:

| MSAA | What you get |
| --- | --- |
| `false` | Lower GPU and memory use |
| `true` (default) | Less noise during motion, with higher GPU and memory use |

For example, `new NeuralDenoiseNode(scene, camera, "performance", false)` disables MSAA. `NeuralDenoisePass` accepts the same arguments. To change MSAA, dispose the node or pass and create another. The viewer has an **MSAA** switch, on by default.

With MSAA off, stabilization is stronger to reduce flicker, which can add some trailing or softness during motion.

## Before you start

- **WebGL2 requirements.** Both WebGL2 paths require `EXT_color_buffer_float`. MSAA also requires `OES_sample_variables`; check `renderer.getContext().getExtension("OES_sample_variables")` before constructing the denoiser. If it is unavailable, pass `msaa = false`. Unsupported configurations throw an error.
- **One camera.** Use a `PerspectiveCamera` or `OrthographicCamera`. WebXR is not supported.
- **Stencil masks.** Create the Three.js renderer with `stencil: true` to use them.
- **Reset after a jump.** Call `denoise.reset()` after a camera cut or scene replacement. Resizing resets automatically; normal object movement needs no reset.
- **On-demand rendering.** Keep rendering after each change so the image can settle. The viewer renders 128 additional frames.

## WebGPURenderer: NeuralDenoiseNode

After `await renderer.init()`, with an existing `renderer`, `scene`, `camera`, and `splatRenderer`:

```js
import { NeuralDenoiseNode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

splatRenderer.stochastic = true;

const denoise = new NeuralDenoiseNode(scene, camera);
const pipeline = new RenderPipeline(renderer, denoise);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});

// On a camera cut or scene replacement: denoise.reset().
// On cleanup: stop the animation loop, then dispose the pipeline and denoise.
```

The node renders the scene and follows the renderer's size automatically.

Chain effects from the node or from `denoise.getTextureNode()`. For Bloom, create the pipeline like this instead:

```js
import { bloom } from "three/addons/tsl/display/BloomNode.js";

const color = denoise.getTextureNode();
const pipeline = new RenderPipeline(renderer, color.add(bloom(color, 0.6, 0.4, 0.8)));
```

## WebGLRenderer: NeuralDenoisePass

Use the pass in place of `RenderPass` or `TAAPass`:

```js
import { NeuralDenoisePass } from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

splatRenderer.stochastic = true;

const denoise = new NeuralDenoisePass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(denoise);
// Insert Bloom or other effects here.
composer.addPass(new OutputPass());

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  composer.render();
});

// On resize: update the renderer size and camera projection,
// then call composer.setSize(width, height) in CSS pixels.
// On a camera cut or scene replacement: denoise.reset().
// On cleanup: stop the animation loop, then dispose the composer and each pass.
```

## Color

`RenderPipeline`, or the composer's `OutputPass`, applies tone mapping and the output color space at the end.

With `NeuralDenoiseNode` in a linear working color space, enabling MSAA can make partly transparent Splats look brighter. This does not occur with `NeuralDenoisePass` or the viewer's sRGB working color space. MSAA results can also differ at edges between WebGPU and WebGL2.

## Properties

| Property | Default | Description |
| --- | --- | --- |
| `scene` | Constructor scene | Scene to render; call `reset()` when replacing it |
| `camera` | Constructor camera | Camera to render with; call `reset()` when replacing it |
| `mode` | `"quality"` | Read-only. `"performance"` or `"quality"` |
| `msaa` | `true` | Read-only. Whether 4× MSAA is enabled |
| `depthTexture` | Read-only | Scene depth of the current frame |
| `projectionMatrix` | Read-only | Projection that matches `depthTexture` |
| `stabilize` | `true` | Reduces flicker in both modes; disabling it can make the image less steady |

Read `depthTexture` when setting up a depth-based effect; it updates each frame after that. Use the matching `projectionMatrix` for depth conversion, rather than `camera.projectionMatrix`. The depth is not smoothed.

## Methods

| Method | Description |
| --- | --- |
| `reset()` | Discard earlier frames and start smoothing again |
| `dispose()` | Release the resources it holds. The scene is not disposed |
| `setSize(width, height)` | Resize in physical pixels. Called for you; a size change resets |
| `getTextureNode()` | Node only: the smoothed image, for chaining effects |

## Background

Based on Hu et al., [Ultra-fast Neural Inference for Stochastic Gaussian Splatting Denoising](https://arxiv.org/abs/2609.25604), adapted for this library.
