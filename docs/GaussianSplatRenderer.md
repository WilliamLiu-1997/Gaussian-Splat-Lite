# GaussianSplatRenderer

[Back to documentation](../README.md#documentation)

Generates, sorts, and renders all visible `SplatMesh` objects in a scene.

```ts
new GaussianSplatRenderer(options: GaussianSplatRendererOptions)
```

## Basic options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `renderer` | `THREE.WebGLRenderer \| WebGPURenderer` | Required | WebGL2 renderer or initialized WebGPU renderer; the WebGPU renderer's WebGL fallback is unsupported |
| `onDirty` | `() => void` | `undefined` | Called when loading, generation, or sorting requires another render |
| `premultipliedAlpha` | `boolean` | `true` | Uses premultiplied alpha while accumulating Splat RGB |
| `timer` | `THREE.Timer` | New internal timer | Caller owns and updates a supplied timer |
| `autoUpdate` | `boolean` | `true` | Checks the Splat collection once per render call |
| `preUpdate` | `boolean` | `true` | Updates before drawing; WebXR automatic updates run after the active render pass |

## Rendering options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `autoStochastic` | `boolean` | `false` | Uses stochastic rendering during motion until a fresh sort is ready; enables companion depth on sorted frames |
| `stochastic` | `boolean` | `false` | Forces sorting-free stochastic rendering |
| `renderDepth` | `boolean` | `false` | Adds companion depth on non-stochastic frames when `depthWrite` is false |

All three options require built-in shaders. Automatic switching also requires `autoUpdate` and is disabled in WebXR. Manual `stochastic` works in XR; capture methods stay sorted.

With default depth settings, the draw order is opaque meshes, sorted Splat color, companion depth, then later geometry. Stochastic frames write depth directly. Companion depth samples alpha coverage near to far; transparent edges may show noise.

Occlusion depends on draw order and depth testing in later materials. Depth clears or target changes can affect it. `renderDepth` writes scene depth, not a depth image or array.

### Stochastic resolve

For WebGL or WebGPU, compose the scene with spatial noise reduction:

```js
import { StochasticResolvePass } from "gaussian-splat-lite";

splatRenderer.autoStochastic = true;
const resolvePass = new StochasticResolvePass(splatRenderer);
renderer.setAnimationLoop(() => resolvePass.compose(renderer, scene, camera));
```

With a WebGL `EffectComposer` (non-XR), add the pass after scene rendering:

```js
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

composer.addPass(new RenderPass(scene, camera));
composer.addPass(resolvePass);
composer.addPass(new OutputPass());
renderer.setAnimationLoop(() => composer.render());
```

For a custom render graph:

```js
resolvePass.resolve(renderer, inputTarget, outputTarget);
```

Use half-float or float input after the complete scene render. The pass is enabled by default; call `dispose()` when finished.

### WebXR

Use the same `compose()` loop with manual stochastic rendering:

```js
splatRenderer.autoStochastic = false;
splatRenderer.stochastic = true;
```

`compose()` handles eye targets, color conversion, and depth copying. Disabling resolve keeps raw stochastic rendering. Disabling manual stochastic waits for a sorted replacement when `autoUpdate` is enabled.

Custom XR graphs must restore the XR output target before calling `resolve(renderer, input, null)`. Pack eyes horizontally without gaps in `renderer.xr.getCamera().cameras` order, all at y = 0. Input width is the sum of eye widths; height is their maximum. Use eye-local viewports and include a `DepthTexture` to copy depth when the XR output has a depth buffer.

## Quality and appearance options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxStdDev` | `number` | `Math.sqrt(8)` | Maximum standard deviations drawn from each Gaussian center; lower values improve speed but crop edges |
| `minPixelRadius` | `number` | `1` | Minimum screen-space Splat radius |
| `maxPixelRadius` | `number` | `512` | Maximum screen-space Splat radius |
| `minAlpha` | `number` | `0.5 / 255` | Fragments below this alpha are discarded |
| `preBlurAmount` | `number` | `0` | Adds to the covariance diagonal before opacity correction |
| `blurAmount` | `number` | `0.3` | Anti-aliasing blur amount with opacity correction |
| `clipXY` | `number` | `1.25` | Center-clipping factor relative to the X/Y frustum boundary; `1` clips immediately outside it |
| `focalAdjustment` | `number` | `2` | Projected Splat-size adjustment; larger values generally look sharper |

## Sorting, material, and offscreen options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sortRadial` | `boolean` | `false` | Sorts by geometric distance when `true`, or by Z depth when `false` |
| `minSortIntervalMs` | `number` | `0` | Minimum interval between sort calls, in milliseconds |
| `synchronousSort` | `boolean` | `false` | Sorts before drawing and ignores `minSortIntervalMs`: GPU radix sort on WebGPU, main-thread WASM sort on WebGL |
| `transparent` | `boolean` | `true` | Controls sorted Splat blending; stochastic-enabled Splats stay at the end of the opaque list |
| `depthTest` | `boolean` | `true` | Reads the depth buffer for occlusion with regular meshes |
| `depthWrite` | `boolean` | `false` | Writes depth; normally undesirable for transparent Splats |
| `extraUniforms` | `Record<string, unknown>` | `undefined` | Additional values merged into the default shader uniforms |
| `vertexShader` | `string` | Built in | Replaces the default Splat vertex shader in WebGL; custom GLSL is rejected by WebGPU |
| `fragmentShader` | `string` | Built in | Replaces the default Splat fragment shader in WebGL; custom GLSL is rejected by WebGPU |
| `target` | `TargetOptions` | `undefined` | Creates a dedicated offscreen render target |

Worker/WASM sorting is the default on both backends. Switching `synchronousSort` off keeps the current order visible until the worker result is ready.

```ts
type TargetOptions = {
  width: number;
  height: number;
  doubleBuffer?: boolean; // false
  superXY?: number;       // 1-4, default 1
} & THREE.RenderTargetOptions;
```

`superXY` renders at higher resolution; `readTarget()` averages pixels on the CPU. Each target dimension multiplied by `superXY` must be at most 8192.

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

WebGPU decodes stored sRGB colors into `THREE.ColorManagement.workingColorSpace`, then uses the renderer's output conversion. WebGL decodes sRGB only for linear and offscreen targets.

## Common properties and methods

| API | Description |
| --- | --- |
| `update({ scene, camera })` | Manually generates and sorts Splats; returns `Promise<void>` |
| `shrinkResources({ scene, camera })` | Updates the scene, clears cached readbacks, and shrinks renderer GPU/worker allocations; the current display stays active until its replacement is ready |
| `clearSplats()` | Clears the current display buffer without removing scene objects |
| `render(scene, camera)` | Renders with this instance active; normally use the Three.js renderer directly |
| `renderTarget({ scene, camera })` | Renders to the target configured in the constructor |
| `readTarget()` | Reads the latest offscreen result as an RGBA `Uint8Array` |
| `renderReadTarget({ scene, camera })` | Renders and reads an offscreen result |
| `renderCubeMap(...)` | Renders a cube map from a world-space position |
| `readCubeTargets()` | Reads RGBA bytes from all six cube faces |
| `renderEnvMap(...)` | Renders and PMREM-prefilters an environment map |
| `recurseSetEnvMap(root, envMap)` | Assigns an environment map to descendant `MeshStandardMaterial` instances |
| `dispose()` | Releases materials, geometry, textures, targets, and the sorting worker |
| `stochasticActive` | Read-only flag indicating that the current frame is using the stochastic path |
| `depthMesh` | Lazily created depth-only companion mesh |

`premultipliedAlpha`, `transparent`, `depthTest`, `depthWrite`, `synchronousSort`, `autoStochastic`, `stochastic`, and `renderDepth` are also writable properties with the behavior listed above.

For manual updates after scene or camera changes:

```js
splatRenderer.autoUpdate = false;
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```

## On-demand rendering

Connect `onDirty` and camera controls to the same render scheduler:

```js
let needsRender = true;

function requestRender() {
  needsRender = true;
}

controls.addEventListener("update", requestRender);

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  onDirty: requestRender,
});
scene.add(splatRenderer);

renderer.setAnimationLoop((time) => {
  controls.update(time);
  if (!needsRender) return;

  // Clear the flag before rendering so a new onDirty call is preserved.
  needsRender = false;
  renderer.render(scene, camera);
});
```
