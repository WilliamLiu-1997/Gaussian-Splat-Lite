# GaussianSplatRenderer

[Back to documentation](../README.md#documentation)

Draws every visible `SplatMesh` in a scene. Add one to the scene; a single instance displays all your models.

```js
import { GaussianSplatRenderer } from "gaussian-splat-lite";

const splatRenderer = new GaussianSplatRenderer({ renderer });
scene.add(splatRenderer);
```

With `WebGPURenderer`, call `await renderer.init()` before creating it. Create your Three.js renderer with `antialias: false`: multisampling slows Splats down without improving them.

Every option except `renderer` and `timer` is also a property, so you can change it at any time.

## Basic options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `renderer` | `WebGPURenderer \| THREE.WebGLRenderer` | Required | Your Three.js renderer |
| `onDirty` | `() => void` | `undefined` | Called when the image needs a redraw; see [on-demand rendering](#on-demand-rendering) |
| `autoUpdate` | `boolean` | `true` | Update Splats automatically on each render. Set to `false` to call `update()` yourself |
| `preUpdate` | `boolean` | `true` | On WebGL, update before drawing so changes show in the same frame. In WebXR, updates run after drawing. Not used on native WebGPU |
| `timer` | `THREE.Timer` | New internal timer | Share your own timer with [`onFrame`](SplatMesh.md#scene-integration) animations; update it yourself when supplied |
| `premultipliedAlpha` | `boolean` | `true` | Blend with premultiplied alpha |

## Quality options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxStdDev` | `number` | `Math.sqrt(8)` | How far each Splat extends from its center. Lower values trim its soft outer edge and render faster; a trimmed Splat fades to `minAlpha` at its edge instead of ending in a step. `Math.sqrt(4)` to `Math.sqrt(9)` looks acceptable |
| `minPixelRadius` | `number` | `1` | Skip Splats smaller than this radius in screen pixels |
| `minAlpha` | `number` | `1 / 255` | Hide the parts of a Splat more transparent than this |
| `preBlurAmount` | `number` | `0.3` | Enlarge and soften Splats. Use `0` for models trained with anti-aliasing |
| `blurAmount` | `number` | `0` | Soften Splats while adjusting their opacity to compensate. For models trained with anti-aliasing, use `0.3` together with `preBlurAmount: 0` |
| `clipXY` | `number` | `1.25` | How far outside the view a Splat's center may be before the Splat is skipped; `1` cuts exactly at the edge |
| `focalAdjustment` | `number` | `2` | Adjust the size of Splats on screen; higher values generally look sharper |

A Splat's radius on screen is limited automatically to the short side of the viewport.

## Sorting and blending options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sortRadial` | `boolean` | `false` | Sort by distance from the camera instead of by depth. Depth suits most models; distance is steadier while the camera rotates |
| `fastSort` | `boolean` | `true` | Faster, lower-precision sorting. Has no effect on stochastic rendering |
| `minSortIntervalMs` | `number` | `0` | Minimum time between sorts on WebGL. Not used on native WebGPU |
| `transparent` | `boolean` | `true` | Blend Splats as transparent objects |
| `encodeLinear` | `boolean` | `undefined` | Convert model colors from sRGB to linear before blending; `false` keeps their sRGB values. Chosen automatically when unset |
| `depthTest` | `boolean` | `true` | Let other geometry hide the Splats behind it |
| `depthWrite` | `boolean` | `false` | Write Splat depth. Normally leave off, because most of a Splat is transparent |

On native WebGPU, Splats are sorted before every draw. On WebGL, sorting finishes in the background: after the view changes, the previous order stays on screen until the new one is ready.

## Stochastic rendering options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `stochastic` | `boolean` | `false` | Use stochastic rendering; smooth its noise with temporal anti-aliasing |
| `stochasticSort` | `boolean` | `true` | Sort Splats from front to back in stochastic rendering; `false` skips sorting |
| `autoAdvanceStochasticSample` | `boolean` | `true` | Change the noise pattern on every render, including in WebXR |

See [Stochastic rendering](StochasticRendering.md) for setup.

## Properties and methods

| API | Description |
| --- | --- |
| `update({ scene, camera })` | Bring the Splats up to date with the scene and camera; returns a promise. Only needed with `autoUpdate = false` |
| `shrinkResources({ scene, camera })` | Update, then release memory that is no longer needed, for example after removing large models; returns a promise |
| `clearSplats()` | Clear the Splats from the display without removing models from the scene |
| `dispose()` | Release this renderer's resources |
| `stochasticActive` | Read-only. Whether stochastic rendering is currently being drawn; it changes shortly after you set `stochastic` |
| `stochasticSample` | Noise pattern index, `0` by default. Set `autoAdvanceStochasticSample = false` to control it yourself |
| `synchronousSort` | Read-only. `true` when Splats are always sorted before they are drawn, as on native WebGPU |

To update manually after the scene or camera changes:

```js
splatRenderer.autoUpdate = false;
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```

Errors during automatic updates are logged to the console, once per message, and rendering continues. Errors from your own `update()` calls are thrown to you.

## WebXR and multiple views

WebXR needs no extra setup: render with your application camera as usual. A Splat model on either eye's layers is visible in both eyes.

For several views outside WebXR, render each one with its own camera. `ArrayCamera` is supported only in WebXR: elsewhere `update()` throws, and automatic draws skip the Splats and log an error. If each view needs its own sort order, give each camera its own Splat renderer on a separate layer.

## Color and postprocessing

Model colors are converted for you. Control the final image with your Three.js renderer's output color space, as for any other scene.

Set `encodeLinear` to choose the conversion yourself. For example, to blend Splats in sRGB next to a linear scene, render them into their own target with `encodeLinear: false`, then unpremultiply that layer, convert it to linear, and premultiply it again before compositing.

For temporal anti-aliasing and effects such as Bloom, see [TAAPass and TAANode](TAAPass.md). To render offscreen, read pixels back, or build cube and environment maps, use [SplatCapture](SplatCapture.md).

## On-demand rendering

To render only when something changes, connect `onDirty` and your controls to the same render request. This example assumes `renderer`, `scene`, and `camera` already exist:

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
requestRender(); // Loading may finish after the last requested render.
```

Request a render yourself after changing a model:

```js
splat.opacity = 0.5;
requestRender();
```

See the [quick start](../README.md#quick-start) for a complete setup.
