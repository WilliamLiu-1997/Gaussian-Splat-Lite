# GaussianSplatRenderer

[Back to documentation](../README.md#documentation)

Renders all visible `SplatMesh` objects in a scene. One instance can display multiple models.

```ts
new GaussianSplatRenderer(options: GaussianSplatRendererOptions)
```

## Basic options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `renderer` | `THREE.WebGLRenderer \| WebGPURenderer` | Required | Three.js renderer; call `await renderer.init()` first when using WebGPURenderer |
| `onDirty` | `() => void` | `undefined` | Called when the image needs a redraw |
| `premultipliedAlpha` | `boolean` | `true` | Use premultiplied alpha for blending |
| `timer` | `THREE.Timer` | New internal timer | Optional shared timer; update it yourself when supplied |
| `autoUpdate` | `boolean` | `true` | Update visible Splats when rendering |
| `preUpdate` | `boolean` | `true` | Update before rendering on WebGL; XR updates follow the render pass. Unused on native WebGPU |

## Rendering options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `autoStochastic` | `boolean` | `false` | Use stochastic rendering during movement, then return to sorted rendering with depth |
| `stochastic` | `boolean` | `false` | Always use stochastic rendering for responsive movement, with visible noise |
| `renderDepth` | `boolean` | `false` | Let Splats occlude later geometry on sorted frames when `depthWrite` is off |

These options require the built-in materials. Stochastic rendering can look noisy while active. Automatic switching requires `autoUpdate` and is disabled in WebXR. Manual `stochastic` works in XR; captures use sorted rendering.

`renderDepth` lets Splats occlude geometry drawn later. Draw order and depth testing in other materials still matter; transparent edges may show noise. It does not return a depth image.

### Stochastic resolve

See [StochasticResolvePass](StochasticResolvePass.md) for stochastic noise reduction, renderer binding, post-processing, and XR usage.

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

## Sorting, material, and offscreen options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sortRadial` | `boolean` | `false` | Sort by distance when `true`, or by camera depth when `false` |
| `fastSort` | `boolean` | `true` | Lower-precision sorting on WebGPU and WebGL; no effect on stochastic rendering |
| `minSortIntervalMs` | `number` | `0` | Minimum time between WebGL sorts; unused on native WebGPU |
| `transparent` | `boolean` | `true` | Enable transparent blending in sorted rendering |
| `depthTest` | `boolean` | `true` | Respect depth from other geometry |
| `depthWrite` | `boolean` | `false` | Write depth directly; normally leave off for transparent Splats |
| `extraUniforms` | `Record<string, unknown>` | `undefined` | Additional shader values |
| `vertexShader` | `string` | Built in | Custom vertex shader for WebGLRenderer only |
| `fragmentShader` | `string` | Built in | Custom fragment shader for WebGLRenderer only |
| `target` | `TargetOptions` | `undefined` | Set the size and options for offscreen captures |

On WebGL, the current sort order stays in use until a new sort is ready. Native WebGPU sorts before drawing. Use stochastic rendering for more responsive movement, with some visible noise.

```ts
type TargetOptions = {
  width: number;
  height: number;
  doubleBuffer?: boolean; // false
  superXY?: number;       // 1-4, default 1
} & THREE.RenderTargetOptions;
```

`superXY` improves capture quality by rendering at higher resolution. The returned image keeps the requested width and height. Each dimension multiplied by `superXY` must be at most 8192.

```js
const captureRenderer = new GaussianSplatRenderer({
  renderer,
  target: { width: 1920, height: 1080, superXY: 2 },
});
scene.add(captureRenderer);
await captureRenderer.update({ scene, camera });
const rgba = await captureRenderer.renderReadTarget({ scene, camera });
// RGBA Uint8Array: 1920 * 1080 * 4 bytes.
```

If a display renderer shares the scene, use `layers` or `visible` to keep both Splat renderers from drawing in the same pass.

### Color management

Built-in materials handle model color conversion. Use your Three.js renderer's output color-space settings to control the final image.

## Common properties and methods

| API | Description |
| --- | --- |
| `update({ scene, camera })` | Refresh the scene and camera state; returns `Promise<void>` |
| `shrinkResources({ scene, camera })` | Reduce retained rendering resources after scene changes |
| `clearSplats()` | Clear the current Splat display without removing scene objects |
| `render(scene, camera)` | Renders with this instance active; normally use the Three.js renderer directly |
| `renderTarget({ scene, camera })` | Renders to the target configured in the constructor |
| `readTarget()` | Reads the latest offscreen result as an RGBA `Uint8Array` |
| `renderReadTarget({ scene, camera })` | Renders and reads an offscreen result |
| `renderCubeMap(...)` | Renders a cube map from a world-space position |
| `readCubeTargets()` | Reads RGBA bytes from all six cube faces |
| `renderEnvMap(...)` | Capture an environment map for lighting |
| `recurseSetEnvMap(root, envMap)` | Assigns an environment map to descendant `MeshStandardMaterial` instances |
| `dispose()` | Release this renderer's resources |
| `stochasticActive` | Read whether the current frame uses stochastic rendering |
| `synchronousSort` | Read whether sorting finishes before drawing: `true` on native WebGPU |
| `depthMesh` | Depth-only mesh used by depth rendering |

`premultipliedAlpha`, `transparent`, `depthTest`, `depthWrite`, `autoStochastic`, `stochastic`, and `renderDepth` are also writable properties with the behavior listed above.

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

Dispose textures returned by `renderEnvMap()` when no longer needed. See the [overview](Architecture.md) for the main loading and rendering workflow.
