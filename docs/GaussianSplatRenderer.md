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

## Sorting, material, and offscreen options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sortRadial` | `boolean` | `false` | Sorts by geometric distance when `true`, or by Z depth when `false` |
| `minSortIntervalMs` | `number` | `0` | Minimum interval between sort calls, in milliseconds |
| `synchronousSort` | `boolean` | `false` | Uses one accumulator and sorts before drawing: GPU radix sort on WebGPU, main-thread WASM sort on WebGL |
| `transparent` | `boolean` | `true` | Places the Splat material in the Three.js transparent render pass |
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
| `render(scene, camera)` | Performs one Three.js render using this instance as the active Splat renderer |
| `renderTarget({ scene, camera })` | Renders to the target configured in the constructor |
| `readTarget()` | Reads the latest offscreen result as an RGBA `Uint8Array` |
| `renderReadTarget({ scene, camera })` | Renders and reads an offscreen result |
| `renderCubeMap(...)` | Renders a cube map from a world-space position |
| `readCubeTargets()` | Reads RGBA bytes from all six cube faces |
| `renderEnvMap(...)` | Renders and PMREM-prefilters an environment map |
| `recurseSetEnvMap(root, envMap)` | Assigns an environment map to descendant `MeshStandardMaterial` instances |
| `dispose()` | Releases materials, geometry, textures, targets, and the sorting worker |
| `premultipliedAlpha` | A read/write property that recompiles the material when changed |
| `transparent` | A read/write property that controls whether Splats use the transparent render pass and recompiles the material when changed |
| `depthTest` | A read/write property that controls whether Splats are tested against the depth buffer |
| `depthWrite` | A read/write property that controls whether Splats write to the depth buffer |
| `synchronousSort` | Switches between the default double-accumulator Worker pipeline and same-frame sorting with one accumulator; WebGPU sorts on the GPU |

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
