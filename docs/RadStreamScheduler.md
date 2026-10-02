# RadStreamScheduler

[Back to documentation](../README.md#documentation)

Loads large RAD scenes with detail that adapts as the camera moves. Supports RAD version 1 with levels of detail (LOD), as a single `.rad` file or split files with `.radc` companions. Works on WebGPU and WebGL2 without a Spark runtime.

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

// Requires update() to keep running.
await streaming.firstRenderable;

// When removing the model:
// streaming.dispose();
// streaming.group.removeFromParent();
```

Use `streaming.group` to position, rotate, scale, or hide the scene. Streamed models support SDF edits and picking; their data is read-only.

Resolution is in CSS pixels, without the device pixel ratio, so a scene selects the same detail on standard and high-DPI displays. Register several cameras to load detail for all of them; they share one selection at the greatest detail any of them needs.

In WebXR, register `renderer.xr.getCamera()` in place of your camera. Detail is selected for each eye at the headset's resolution, so no resolution is needed:

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

Ordinary camera matrices are updated by the scheduler. The XR camera's matrices are read directly from Three.js, so detail selection before rendering may use the previous frame's pose.

For original Splat IDs, use the picking hit's [`sourceIndex`](SplatMesh.md#raycasting).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` / `file` / `fileBytes` | Exactly one required | URL, `Blob`/`File`, or complete `Uint8Array`/`ArrayBuffer` |
| `resolveFile` | Relative URL resolution | Companion-page resolver: `(filename, signal) => URL \| Blob \| Uint8Array \| ArrayBuffer`, optionally asynchronous |
| `group` | New `THREE.Group` | Parent group for moving, rotating, scaling, or hiding the scene |
| `splatBudget` | `3_000_000` | Maximum selected Splat count before transition overlap |
| `cooldownMs` | `2000` | Milliseconds to retain unused pages after fade-out; `0` releases eligible pages immediately |
| `fadeDurationMs` | `200` | Initial visibility and LOD fade duration in milliseconds; `0` switches immediately |
| `maxConcurrentLoads` | `4` | Maximum simultaneous loads |
| `manager` | `THREE.DefaultLoadingManager` | Loading manager and URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings; sensitive settings are not forwarded to other origins |
| `onChange` | — | Request a redraw when data or visibility changes |
| `onError` | Console error | Failure callback: `(error, url)` |

Existing detail stays visible while replacement detail loads. Fades can temporarily exceed `splatBudget`; use `fadeDurationMs: 0` to switch immediately. Cached data also uses memory, so the budget is not a total memory limit.

Ready pages are written during `update()` without a per-update byte limit. Loading concurrency and pending decode memory remain bounded.

## Common properties and methods

| API | Description |
| --- | --- |
| `group` | Parent group for moving, rotating, scaling, or hiding the scene |
| `splatBudget` | Positive safe integer; change it at runtime to adjust detail, even while the camera is stationary |
| `initialized` | Resolves when scene setup is ready; rejects invalid or unsupported input |
| `firstRenderable` | Resolves when the first data becomes visible, or the scene is empty; rejects if the first data cannot be loaded. Keep calling `update()` while waiting |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that selects detail; `hasCamera(camera)` and `cameras` list them |
| `setResolution(camera, width, height)` | Set a registered camera's render size in CSS pixels; also accepts a `THREE.Vector2` |
| `setResolutionFromRenderer(camera, renderer)` | Set a registered camera's resolution from `renderer.getSize()` |
| `update()` | Update detail, loading, fades, and cleanup for the registered cameras; throws if none are registered |
| `getBoundingBox()` | Approximate bounds in group coordinates; empty until the first data loads |
| `getGlobalIndex(mesh, renderedIndex)` | Convert a picking result to a stable node index in the RAD file |
| `stats` | Visible and retained Splat data, loading progress, and memory estimates; not total browser memory |
| `dispose()` | Cancel loading and release scene resources; pending readiness promises reject with `AbortError` |

For on-demand rendering, use `onChange` to request redraws and keep calling `update()` each animation tick so loading, retries, fades, and cleanup progress.

Cooldown uses elapsed time, independent of update frequency. Pending LOD decisions defer expired-page cleanup so newly needed pages can be reused. Each accepted decision updates demand before cleanup, even during camera movement; existing page pins still apply.

```js
const hits = raycaster.intersectObject(streaming.group, true);
if (hits.length && hits[0].index !== undefined) {
  const nodeIndex = streaming.getGlobalIndex(hits[0].object, hits[0].index);
  console.log(nodeIndex, hits[0].point);
}
```

## Error recovery

Temporary download failures and lost decoder workers are retried automatically, waiting longer after each attempt, up to 30 seconds. Retryable HTTP errors are 408, 425, 429, and 5xx. Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and not retried. Each retry calls `onChange`, so on-demand render loops resume loading once the connection returns.

If LOD selection or preparation fails, or the LOD worker is lost during page loading, `onError` is called and the scene keeps its current detail but stops refining; create a new scheduler to try again.
