# GaussianSplatRenderer

[Back to the API overview](../README.md#core-concepts-and-public-api)

```ts
new GaussianSplatRenderer(options: GaussianSplatRendererOptions)
```

Stored Splat colors are decoded from sRGB before blending into linear render
targets. WebGPU performs this decode into `THREE.ColorManagement.workingColorSpace`
and lets the renderer apply its normal working-to-output conversion. WebGL keeps
the established behavior of decoding only for linear and offscreen targets.

## Basic options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `renderer` | `THREE.WebGLRenderer \| WebGPURenderer` | Required | A WebGL renderer or an initialized renderer from `three/webgpu` using its native WebGPU backend |
| `onDirty` | `() => void` | `undefined` | Called when loading, generation, or sorting requires another render |
| `premultipliedAlpha` | `boolean` | `true` | Uses premultiplied alpha while accumulating Splat RGB |
| `timer` | `THREE.Timer` | New internal timer | Shares time with another animation system; caller owns and updates a supplied timer |
| `autoUpdate` | `boolean` | `true` | Automatically checks the Splat collection each frame |
| `preUpdate` | `boolean` | `true` | Updates before drawing; WebXR automatic updates run after the active render pass |

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

## Rendering options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `autoStochastic` | `boolean` | `false` | Uses stochastic rendering during camera motion, then returns to sorted rendering |
| `stochastic` | `boolean` | `false` | Forces sorting-free stochastic rendering |
| `renderDepth` | `boolean` | `false` | Forces the depth-only companion draw |

Enable `autoStochastic` to use stochastic rendering while the camera moves and
until a fresh sort is ready:

```js
const splatRenderer = new GaussianSplatRenderer({
  renderer,
  autoStochastic: true,
  onDirty: requestRender, // Required for on-demand rendering.
});
scene.add(splatRenderer);
```

- `stochastic: true` forces the stochastic path.
- `renderDepth: true` forces the companion depth draw; `autoStochastic` enables it automatically.
- All three options require built-in shaders; `autoStochastic` also requires `autoUpdate`. WebXR and capture methods stay sorted.

### Stochastic resolve

With `EffectComposer`:

```js
const resolvePass = new StochasticResolvePass(splatRenderer);

composer.addPass(new RenderPass(scene, camera));
composer.addPass(resolvePass);
composer.addPass(new OutputPass());
```

Other integrations:

```js
resolvePass.compose(renderer, scene, camera); // No composer.
resolvePass.resolve(renderer, inputTarget, outputTarget); // Custom render graph.
```

Place the pass after the complete scene render and use a half-float or float
input. The pass is enabled by default; call `dispose()` when finished.

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

The `target` structure is:

```ts
type TargetOptions = {
  width: number;
  height: number;
  doubleBuffer?: boolean; // false
  superXY?: number;       // 1-4, default 1
} & THREE.RenderTargetOptions;
```

`superXY` renders at a higher resolution and performs simple CPU averaging when `readTarget()` is called. Both `width * superXY` and `height * superXY` must be no greater than 8192.

## Common properties and methods

| API | Description |
| --- | --- |
| `update({ scene, camera })` | Manually generates and sorts Splats; returns `Promise<void>` |
| `shrinkResources({ scene, camera })` | Synchronizes the scene like an explicit update, releases cached readback buffers, and shrinks renderer-owned accumulator, ordering, and sort-worker resources to their current allocation tiers; the previous display remains active until its replacement is ready |
| `clearSplats()` | Clears the current display buffer without removing scene objects |
| `render(scene, camera)` | Performs one Three.js render using this instance as the active Splat renderer; ordinary applications can call the underlying renderer directly |
| `renderTarget({ scene, camera })` | Renders to the target configured in the constructor |
| `readTarget()` | Reads the latest offscreen result as an RGBA `Uint8Array` |
| `renderReadTarget({ scene, camera })` | Renders and reads an offscreen result |
| `renderCubeMap(...)` | Renders a cube map from a world-space position |
| `readCubeTargets()` | Reads RGBA bytes from all six cube faces |
| `renderEnvMap(...)` | Renders and PMREM-prefilters an environment map |
| `recurseSetEnvMap(root, envMap)` | Assigns an environment map to descendant `MeshStandardMaterial` instances |
| `dispose()` | Releases materials, geometry, textures, targets, and the sorting worker |
| `premultipliedAlpha` | A read/write property that controls premultiplied Splat RGB output |
| `transparent` | Controls sorted Splat blending; stochastic-enabled Splats stay at the end of the opaque list so per-frame state changes are deterministic |
| `depthTest` | A read/write property that controls whether Splats are tested against the depth buffer |
| `depthWrite` | A read/write property that controls whether Splats write to the depth buffer |
| `synchronousSort` | Switches between the default double-accumulator Worker pipeline and same-frame sorting with one accumulator; WebGPU sorts on the GPU |
| `autoStochastic` | Enables stochastic rendering during camera movement; defaults to `false` |
| `stochastic` | Forces sorting-free stochastic rendering; defaults to `false` |
| `stochasticActive` | Read-only flag indicating that the current frame is using the stochastic path |
| `renderDepth` | Forces the depth-only companion draw; defaults to `false` |
| `depthMesh` | Lazily created depth-only companion mesh |

For an on-demand render loop, connect `onDirty` to the application's render scheduler:

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
