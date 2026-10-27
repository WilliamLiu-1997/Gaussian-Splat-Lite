# RadStreamScheduler

[Back to documentation](../README.md#documentation)

Shows large RAD scenes by loading only the detail the camera needs, and updating it as the camera moves. It supports RAD version 1 files with levels of detail (LOD), either as a single `.rad` file or split into a header and `.radc` pages. It works on WebGPU and WebGL2.

To convert your own models, see [Building RAD files](BuildRad.md).

```js
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler({
  url: "/models/scene.rad",
  splatBudget: 3_000_000,
  splatBudgetTolerance: 0.1, // Allow up to 10% extra Splats; 0 forbids overshoot.
  maxResidentCpuBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  maxResidentGpuBytes: 1024 * 1024 * 1024, // 1 GiB
});
scene.add(streaming.group);
streaming.setCamera(camera);
streaming.setResolutionFromRenderer(camera, renderer); // Again after resizing.
await streaming.initialized;

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});

// Keep updating and rendering while waiting for the first data.
await streaming.firstRenderable;

// When removing the model:
// streaming.dispose();
// streaming.group.removeFromParent();
```

The three steps that matter:

1. Add `streaming.group` to the scene. Move, rotate, scale, or hide the scene through this group.
2. Register the camera and its resolution.
3. Call `streaming.update()` before every render.

Streamed models support [SDF edits](SplatEdit.md) and [picking](SplatMesh.md#raycasting). Their data is read-only.

## Multiple inputs

Use `sources` instead of a top-level `url`, `file`, or `fileBytes` to load several RAD inputs together:

```js
const streaming = new RadStreamScheduler({
  sources: [
    { url: "/models/buildings.rad" },
    { url: "/models/landscape.rad" },
  ],
  splatBudget: 3_000_000,
  maxConcurrentLoads: 4,
});
```

All inputs use the coordinates stored in their files, relative to `streaming.group`. Detail is chosen across the combined scene, and the inputs share the splat budget, loading concurrency, and both memory budgets. Inputs with different SH degrees all use the memory of the highest one, up to `maxSh`.

Each entry accepts the single-input loading options, including `resolveFile`, `manager`, `requestHeader`, and `withCredentials`; options omitted from an entry inherit the scheduler's settings. `sources` must be nonempty. Use separate schedulers for inputs that need independent transforms or budgets.

`initialized` waits for every input's metadata. `firstRenderable` resolves when the first selected data is displayed; it does not wait for every input to finish loading. `getBoundingBox()` and `stats` describe the combined scene. `splatBudget` and both memory budgets must be large enough to hold the coarsest detail of every nonempty input.

## Cameras and resolution

Detail depends on how large the scene appears, so each camera needs a resolution. It is in CSS pixels, without the device pixel ratio, so a scene loads the same detail on standard and high-DPI displays. Set it again whenever the canvas is resized.

Register several cameras to load detail for all of them. They share one selection, at the highest detail any of them needs.

### WebXR

Register `renderer.xr.getCamera()` in place of your camera. Detail is chosen for each eye at the headset's resolution, so no resolution is needed:

```js
const xrCamera = renderer.xr.getCamera();
renderer.xr.addEventListener("sessionstart", () => {
  streaming.deleteCamera(camera);
  streaming.setCamera(xrCamera);
});
renderer.xr.addEventListener("sessionend", () => {
  streaming.deleteCamera(xrCamera);
  streaming.setCamera(camera);
  streaming.setResolutionFromRenderer(camera, renderer);
});

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `sources` | — | Multiple inputs sharing this scheduler; see [Multiple inputs](#multiple-inputs) |
| `url` / `file` / `fileBytes` | One required without `sources` | URL, `Blob`/`File`, or complete `Uint8Array`/`ArrayBuffer` |
| `resolveFile` | Relative URLs | Supply the `.radc` pages of a split scene yourself: `(filename, signal) => URL \| Blob \| Uint8Array \| ArrayBuffer`, directly or as a promise |
| `splatBudget` | `3_000_000` | Target number of Splats. Higher values show more detail and use more memory |
| `maxSh` | `3` | Maximum SH degree to decode and store, an integer from `0` to `3`. Set at creation; `0` keeps only the base color |
| `splatBudgetTolerance` | `0.1` | Allowed fractional overshoot of `splatBudget`. `0.1` allows up to 10% extra Splats; `0` keeps each new selection within `splatBudget`. Must be finite and nonnegative |
| `maxResidentCpuBytes` | 2 GiB | CPU memory budget for cached data, in bytes. Set a positive integer when creating the scheduler |
| `maxResidentGpuBytes` | 1 GiB | GPU memory budget for cached data, in bytes. Set a positive integer when creating the scheduler |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long unused detail stays ready for reuse; it can be released sooner when either memory budget is reached. `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of simultaneous loads |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Sensitive settings are not sent to other origins |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |

Detail already on screen stays visible while its replacement loads, if both memory budgets allow. At the limit, the scene may temporarily show less detail. During a fade, old and new detail overlap, so the visible count can briefly exceed the selection limit. Use both `splatBudgetTolerance: 0` and `fadeDurationMs: 0` to keep new selections and their transitions within `splatBudget`.

Unused detail is released after `cooldownMs`, including while hidden, and loads again when needed.

## Properties and methods

| API | Description |
| --- | --- |
| `group` | Group created by this scheduler to hold the streamed scene |
| `splatBudget` | Change it at any time to adjust detail, even while the camera is still. Must be a positive integer |
| `maxSh` | Read-only SH decoding and storage limit chosen at creation |
| `splatBudgetTolerance` | Change the allowed overshoot at any time without reloading. `0` forbids overshoot |
| `initialized` | Resolves when the scene is set up; rejects for invalid or unsupported files |
| `firstRenderable` | Resolves when the first data is on screen, or the scene is empty; rejects if the first data cannot be loaded. Keep updating and rendering while you wait |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that chooses detail. `hasCamera(camera)` and `cameras` report the registered ones |
| `setResolution(camera, width, height)` | Set a registered camera's size in CSS pixels; also accepts a `THREE.Vector2` |
| `setResolutionFromRenderer(camera, renderer)` | Set a registered camera's size from `renderer.getSize()` |
| `update()` | Advance detail selection, loading, and fades. Call it before every render; it throws if no camera is registered |
| `getBoundingBox()` | Approximate box around the scene, in the group's coordinates; empty until the first data loads |
| `stats` | Visible Splats, loading progress, and estimated CPU/GPU cache sizes (`residentCpuBytes` / `residentGpuBytes`) |
| `dispose()` | Stop loading and release the scene. Pending `initialized` and `firstRenderable` promises reject with `AbortError` |

### On-demand rendering

Request a redraw from `onChange`, and keep calling `update()` on every animation tick, also when you skip the render. Loading, retries, and fades only make progress inside `update()`.

New data reaches the screen only when you render, so keep rendering while waiting for `firstRenderable`, even before anything is visible.

### Picking

Hits from a streamed scene refer to the detail that is currently shown. Read the hit Splat before the streaming selection updates, since its index can change:

```js
const hits = raycaster.intersectObject(streaming.group, true);
if (hits.length && hits[0].index !== undefined) {
  const hit = hits[0];
  const splat = hit.object.splats.getSplat(hit.index);
  console.log(splat, hit.point);
}
```

## Error recovery

Temporary download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried.

If the scheduler can no longer choose detail after an internal failure, it calls `onError` and keeps showing its current detail without refining further. Create a new scheduler to try again.
