# RadStreamScheduler

[Back to documentation](../README.md#documentation)

Shows large RAD scenes by loading only the detail the camera needs, and updating it as the camera moves. It supports RAD version 1 files with levels of detail (LOD), either as a single `.rad` file or split into a header and `.radc` pages. It works on WebGPU and WebGL2, and needs no Spark runtime.

```js
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler({
  url: "/models/scene.rad",
  splatBudget: 3_000_000,
});
scene.add(streaming.group);
streaming.setCamera(camera);
streaming.setResolutionFromRenderer(camera, renderer); // Again after resizing.
await streaming.initialized;

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});

// Resolves when the first data is on screen. update() must be running.
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
| `url` / `file` / `fileBytes` | Exactly one required | URL, `Blob`/`File`, or complete `Uint8Array`/`ArrayBuffer` |
| `resolveFile` | Relative URLs | Supply the `.radc` pages of a split scene yourself: `(filename, signal) => URL \| Blob \| Uint8Array \| ArrayBuffer`, directly or as a promise |
| `group` | New `THREE.Group` | Group that holds the scene |
| `splatBudget` | `3_000_000` | Maximum number of Splats shown at once. Higher values show more detail and use more memory |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long detail that is no longer shown stays in memory, ready for reuse; `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of loads in progress at the same time |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Sensitive settings are not sent to other origins |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |

Detail that is already on screen stays there while its replacement loads. During a fade, old and new detail overlap, so the scene can briefly exceed `splatBudget`; use `fadeDurationMs: 0` to prevent this. The budget limits what is shown, not total memory: detail kept for reuse takes memory too.

## Properties and methods

| API | Description |
| --- | --- |
| `group` | Group that holds the scene |
| `splatBudget` | Change it at any time to adjust detail, even while the camera is still. Must be a positive integer |
| `initialized` | Resolves when the scene is set up; rejects for invalid or unsupported files |
| `firstRenderable` | Resolves when the first data is on screen, or the scene is empty; rejects if the first data cannot be loaded. Keep calling `update()` while you wait |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that chooses detail. `hasCamera(camera)` and `cameras` report the registered ones |
| `setResolution(camera, width, height)` | Set a registered camera's size in CSS pixels; also accepts a `THREE.Vector2` |
| `setResolutionFromRenderer(camera, renderer)` | Set a registered camera's size from `renderer.getSize()` |
| `update()` | Advance detail selection, loading, and fades. Call it before every render; it throws if no camera is registered |
| `getBoundingBox()` | Approximate box around the scene, in the group's coordinates; empty until the first data loads |
| `getGlobalIndex(mesh, renderedIndex)` | Convert a picking hit into a node index that stays the same for the whole RAD file |
| `stats` | Numbers for monitoring, such as `visibleSplats`, `loadingChunks`, `downloadedBytes`, and `residentBytes`. Memory figures are estimates, not total browser memory |
| `dispose()` | Stop loading and release the scene. Pending `initialized` and `firstRenderable` promises reject with `AbortError` |

### On-demand rendering

Request a redraw from `onChange`, and keep calling `update()` on every animation tick, also when you skip the render. Loading, retries, and fades only make progress inside `update()`.

### Picking

Hits from a streamed scene refer to the detail that is currently shown. Use `getGlobalIndex()`, or the hit's [`sourceIndex`](SplatMesh.md#raycasting), for an ID that does not change:

```js
const hits = raycaster.intersectObject(streaming.group, true);
if (hits.length && hits[0].index !== undefined) {
  const nodeIndex = streaming.getGlobalIndex(hits[0].object, hits[0].index);
  console.log(nodeIndex, hits[0].point);
}
```

## Error recovery

Temporary download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried.

If the scheduler can no longer choose detail after an internal failure, it calls `onError` and keeps showing its current detail without refining further. Create a new scheduler to try again.
