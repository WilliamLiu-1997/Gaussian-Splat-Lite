# SogStreamScheduler

[Back to documentation](../README.md#documentation)

Shows large SOG `lod-meta.json` scenes by loading only the detail the camera needs, and updating it as the camera moves. It supports version 1 and older unversioned indexes, on WebGPU and WebGL2. For an ordinary `.sog` file or `meta.json`, use [SplatMesh](SplatMesh.md).

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler({
  url: "/scene/lod-meta.json",
  splatBudget: 3_000_000,
});
scene.add(streaming.group);
streaming.setCamera(camera);
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
2. Register the camera.
3. Call `streaming.update()` before every render.

Streamed models support [SDF edits](SplatEdit.md) and [picking](SplatMesh.md#raycasting). Their data is read-only. For a Splat's original ID, use the picking hit's [`sourceIndex`](SplatMesh.md#raycasting).

## Cameras

Detail depends on distance from the camera, so cameras need no resolution. Register several cameras to load detail for all of them; each part of the scene follows the nearest camera that sees it.

In WebXR, register `renderer.xr.getCamera()` in place of your camera, as shown for [RadStreamScheduler](RadStreamScheduler.md#webxr). Detail is chosen for each eye.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | URL of the scene's `lod-meta.json` |
| `group` | New `THREE.Group` | Group that holds the scene |
| `splatBudget` | `3_000_000` | Target number of Splats shown at once, including the environment. Higher values show more detail and use more memory |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long detail that is no longer shown stays in memory, ready for reuse; `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of loads in progress at the same time |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Headers and credentials are not sent to files on other origins |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |
| `loadChunk` | Built-in loader | Load the scene's files yourself: `(url, signal) => Promise<Splats>` |

The budget is a target, not a hard limit: the available detail levels, fades, and the environment can take the scene above it. It limits what is shown, not total memory: detail kept for reuse takes memory too.

Some parts of a scene exist only at finer detail levels. They can be empty from far away and fade in as the camera approaches.

## Properties and methods

| API | Description |
| --- | --- |
| `group` | Group that holds the scene |
| `splatBudget` | Change it at any time to adjust detail. Must be a positive integer; includes the environment |
| `initialized` | Resolves when the index is loaded; rejects for invalid input |
| `firstRenderable` | Resolves when the first data is on screen, or the scene is empty; rejects if the first data cannot be loaded. Keep calling `update()` while you wait |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that chooses detail. `hasCamera(camera)` and `cameras` report the registered ones |
| `update()` | Advance detail selection, loading, and fades. Call it before every render; it throws if no camera is registered |
| `getBoundingBox()` | Box around the scene, in the group's coordinates; available once `initialized` resolves |
| `stats` | Numbers for monitoring, such as `visibleSplats`, `visibleRegions`, `loadingChunks`, `downloadedBytes`, and `residentBytes`. Memory figures are estimates, not total browser memory |
| `dispose()` | Stop loading and release the scene. Pending `initialized` and `firstRenderable` promises reject with `AbortError` |

### On-demand rendering

Request a redraw from `onChange`, and keep calling `update()` on every animation tick, also when you skip the render. Loading, retries, and fades only make progress inside `update()`.

## Error recovery

Temporary download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried. Parts of the scene that are already on screen stay visible when loading more detail fails.

If the scheduler can no longer choose detail after an internal failure, it calls `onError` and disposes itself. Create a new scheduler to try again.
