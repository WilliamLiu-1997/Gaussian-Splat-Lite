# LccStreamScheduler

[Back to documentation](../README.md#documentation)

Shows large XGRIDS LCC and LCC2 scenes by loading only the detail the camera needs, and updating it as the camera moves. It works on WebGPU and WebGL2.

| Format | Open | Files next to it |
| --- | --- | --- |
| LCC | The `.lcc` file (often `meta.lcc`) | `index.bin`, `data.bin`, `shcoef.bin` for scenes with view-dependent color, optional `environment.bin` |
| LCC2 | The `.lcc2` file | The `data` folder with the scene's `.sog`, `.spz`, or `.ply` files |

The format is detected from the file's contents.

```js
import { LccStreamScheduler } from "gaussian-splat-lite";

const streaming = new LccStreamScheduler({
  url: "/scene/meta.lcc", // or "/scene/model.lcc2"
  splatBudget: 3_000_000,
});
// LCC scenes are Z-up; turn them upright in a Y-up Three.js scene.
streaming.group.rotation.x = -Math.PI / 2;
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

Streamed scenes support [SDF edits](SplatEdit.md) and [picking](SplatMesh.md#raycasting). Their data is read-only.

## Hosting

Keep the files exactly as exported, next to the `.lcc` or `.lcc2` file. LCC streaming reads parts of `data.bin` and `shcoef.bin`, so the server must support HTTP byte-range requests. Remote hosts must allow CORS.

## How detail is chosen

The whole scene stays covered at its coarsest level, then detail is added where the cameras look, nearest first, until the budget is used. A part of the scene switches to finer or coarser detail only once all of its replacement has loaded, and fades between the two.

In LCC, the smallest part that can change detail is a Unit, a square cell of the scene. A Unit with many Splats can stay coarser than its neighbors when its next level does not fit the remaining budget. LCC2 scenes change detail per node.

## Cameras

Detail depends on distance from the camera, so cameras need no resolution. Register several cameras to load detail for all of them; each part of the scene follows the nearest camera that sees it.

In WebXR, register `renderer.xr.getCamera()` in place of your camera, as shown for [RadStreamScheduler](RadStreamScheduler.md#webxr). Detail is chosen for each eye.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | URL of the scene's `.lcc` or `.lcc2` file |
| `group` | New `THREE.Group` | Group that holds the scene |
| `splatBudget` | `3_000_000` | Splat budget, including the environment. Higher values allow more detail and use more memory |
| `splatBudgetMode` | `"target"` | `"target"` adjusts the distance bands to fill the budget. `"limit"` uses the configured distance bands and only reduces detail when they exceed the budget |
| `lodBaseDistance` | `100` | Base LOD distance in world units for `"limit"` mode, compensated for the camera's field of view. Higher values retain finer detail farther away. Must be finite and positive |
| `lodMultiplier` | `2` | Distance multiplier between successive LOD levels in both modes. Must be finite and at least `1` |
| `environment` | `true` | Show the scene's environment Splats, the distant surroundings some exports include |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long detail that is no longer shown stays in memory, ready for reuse; `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of loads in progress at the same time |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Headers and credentials are not sent to files on other origins |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |

During a fade, old and new detail overlap, so the visible count can briefly exceed the budget.

## Properties and methods

| API | Description |
| --- | --- |
| `group` | Group that holds the scene |
| `splatBudget` | Change it at any time to adjust detail. Must be a positive integer; includes the environment |
| `splatBudgetMode` | Switch between `"target"` and `"limit"` without reloading |
| `lodBaseDistance` | Change the base LOD distance in `"limit"` mode without reloading |
| `lodMultiplier` | Change the distance spacing between LOD levels in both modes without reloading |
| `initialized` | Resolves when the scene's index is loaded; rejects for invalid input |
| `firstRenderable` | Resolves when the first data is on screen, or the scene is empty; rejects if the first data cannot be loaded. Keep calling `update()` while you wait |
| `info` | The scene's format (`"lcc"` or `"lcc2"`), version, Splats per level (finest first), and its `epsg`, `offset`, `shift`, and `scale` values as stored; available once `initialized` resolves |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that chooses detail. `hasCamera(camera)` and `cameras` report the registered ones |
| `update()` | Advance detail selection, loading, and fades. Call it before every render; it throws if no camera is registered |
| `getBoundingBox()` | Box around the scene without its environment, in the group's coordinates; available once `initialized` resolves |
| `stats` | Visible Splats, loading progress, and estimated CPU/GPU cache sizes (`residentCpuBytes` / `residentGpuBytes`) |
| `dispose()` | Stop loading and release the scene. Pending `initialized` and `firstRenderable` promises reject with `AbortError` |

### On-demand rendering

Request a redraw from `onChange`, and keep calling `update()` on every animation tick, also when you skip the render. Loading, retries, and fades only make progress inside `update()`.

### Coordinates

The scene keeps the coordinates stored in its files. `info.epsg` and `info.offset` describe where a georeferenced scene belongs; they are not applied, so place `streaming.group` yourself.

### Picking

Hits refer to the detail that is currently shown. A hit's [`sourceIndex`](SplatMesh.md#raycasting) is the Splat's record index in `data.bin` for LCC, or its index within the `.sog`, `.spz`, or `.ply` file it was loaded from for LCC2.

## Not supported

Collision and mesh data (`collision.lci`, and LCC2 mesh and BVH files) are not loaded. LCC2 virtual LOD levels and extra Splat attributes are ignored. LCC files must use the `COMPRESS` encoding.

## Error recovery

Temporary download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried. Parts of the scene that are already on screen stay visible when loading more detail fails.

If the scheduler can no longer choose detail after an internal failure, it calls `onError` and disposes itself. Create a new scheduler to try again.

## Attribution

LCC and LCC2: Data Organization Format originated from XGRIDS. The formats are described in the [LCC](https://github.com/xgrids/LCCWhitepaper) and [LCC2](https://github.com/xgrids/LCC2Whitepaper) whitepapers, whose license terms apply to applications that use them, including a visible attribution and a restriction on training competing AI models. Gaussian Splat Lite reads these formats independently and is not endorsed by XGRIDS.
