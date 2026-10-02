# GaussianSplatRenderer

[Back to documentation](../README.md#documentation)

Renders all visible `SplatMesh` objects in a scene. One instance can display multiple models.

```ts
new GaussianSplatRenderer(options: GaussianSplatRendererOptions)
```

## Basic options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `renderer` | `WebGPURenderer \| THREE.WebGLRenderer` | Required | Three.js renderer; call `await renderer.init()` first when using WebGPURenderer |
| `onDirty` | `() => void` | `undefined` | Called when the image needs a redraw |
| `premultipliedAlpha` | `boolean` | `true` | Use premultiplied alpha for blending |
| `timer` | `THREE.Timer` | New internal timer | Optional shared timer; update it yourself when supplied |
| `autoUpdate` | `boolean` | `true` | Update visible Splats when rendering |
| `preUpdate` | `boolean` | `true` | Update before rendering on WebGL; XR updates follow the render pass. Unused on native WebGPU |

## Quality and appearance options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxStdDev` | `number` | `Math.sqrt(8)` | Control the extent of each Splat; lower values crop its outer edges |
| `minPixelRadius` | `number` | `1` | Skip Splats smaller than this screen radius in pixels |
| `maxPixelRadius` | `number` | `256` | Limit Splat screen radius in pixels, independently of `focalAdjustment` |
| `minAlpha` | `number` | `0.5 / 255` | Hide parts more transparent than this value |
| `preBlurAmount` | `number` | `0.3` | Enlarge and soften Splats |
| `blurAmount` | `number` | `0` | Add smoothing with an opacity adjustment |
| `clipXY` | `number` | `1.25` | Allow centers slightly outside the view; `1` clips at its edge |
| `focalAdjustment` | `number` | `2` | Adjust projected size; higher values generally look sharper |

## Sorting and material options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sortRadial` | `boolean` | `false` | Sort by distance when `true`, or by camera depth when `false` |
| `fastSort` | `boolean` | `true` | Lower-precision back-to-front sorting; does not affect stochastic rendering |
| `minSortIntervalMs` | `number` | `0` | Minimum time between WebGL sorts; unused on native WebGPU |
| `stochastic` | `boolean` | `false` | Enable stochastic rendering; use temporal anti-aliasing to smooth its noise |
| `autoAdvanceStochasticSample` | `boolean` | `true` | Change the noise pattern on each render while stochastic rendering is active, including WebXR |
| `stochasticSort` | `boolean` | `true` | Sort stochastic Splats from front to back; set to `false` to skip sorting |
| `transparent` | `boolean` | `true` | Enable transparent blending in sorted rendering |
| `depthTest` | `boolean` | `true` | Respect depth from other geometry |
| `depthWrite` | `boolean` | `false` | Write depth directly; normally leave off for transparent Splats |

Native WebGPU sorts before drawing. On WebGL, the current sort order stays in use until a new sort is ready.

Automatic update errors are caught and logged once per error message, preventing unhandled promise rejections. If draw preparation fails, that draw is skipped so rendering can continue. Explicit `update()` calls report errors to the caller.

See [Stochastic rendering](StochasticRendering.md) for setup and temporal anti-aliasing.

### WebXR and multiple views

WebXR uses the eyes' mean pose for generation and sorting, with a separate projection for each eye. Splats on either eye's layers are visible in both eyes. Eye poses are read directly from Three.js's world matrices, preserving the camera rig transform.

With `autoUpdate = true`, render normally with your application camera; Three.js updates the XR camera when rendering.

For multiple views outside WebXR, use separate cameras. Non-XR `ArrayCamera` rendering is not supported: `update()` throws, and other draws skip Splats and log an error. For independent sorting, give each camera its own Splat renderer on a separate layer.

### Color management

Built-in materials handle model color conversion. Use your Three.js renderer's output color-space settings to control the final image.

## Common properties and methods

| API | Description |
| --- | --- |
| `update({ scene, camera })` | Refresh the scene and camera state; returns `Promise<void>` |
| `shrinkResources({ scene, camera })` | Reduce retained rendering resources after scene changes |
| `clearSplats()` | Clear the current Splat display without removing scene objects |
| `dispose()` | Release this renderer's resources |
| `stochasticActive` | Read whether stochastic rendering is still active while switching modes |
| `stochasticSample` | Noise pattern index; defaults to 0. Each value selects an independent pattern. Disable `autoAdvanceStochasticSample` to control it yourself |
| `synchronousSort` | Read whether sorting finishes before drawing: `true` on native WebGPU |

`premultipliedAlpha`, `transparent`, `depthTest`, and `depthWrite` are also writable properties with the behavior listed above.

For manual updates after scene or camera changes:

```js
splatRenderer.autoUpdate = false;
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```

## On-demand rendering

Connect `onDirty` and `OrbitControls` to the same render scheduler. This example assumes `renderer`, `scene`, and `camera` already exist; use it in place of the earlier Splat renderer setup and render loop.

```js
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";

let needsRender = true;

function requestRender() {
  needsRender = true;
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.addEventListener("change", requestRender);

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  onDirty: requestRender,
});
scene.add(splatRenderer);

renderer.setAnimationLoop(() => {
  // Keep damping active even when the previous frame needed no render.
  controls.update();
  if (!needsRender) return;

  // Clear the flag before rendering so a new onDirty call is preserved.
  needsRender = false;
  renderer.render(scene, camera);
});

const splat = new SplatMesh({ url: "/assets/model.spz" });
scene.add(splat);
requestRender();
await splat.initialized;
requestRender(); // Loading may finish after the render scheduler becomes idle.
```

```js
splat.opacity = 0.5;
requestRender();
```

See the [overview](Architecture.md) for the main loading and rendering workflow.
