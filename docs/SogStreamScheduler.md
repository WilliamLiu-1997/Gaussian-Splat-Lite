# SogStreamScheduler

[Back to documentation](../README.md#documentation)

Shows large SOG `lod-meta.json` scenes with camera-driven detail, keeping coarser surroundings ready as the camera turns. It supports version 1 and older unversioned indexes, on WebGPU and WebGL2. For an ordinary `.sog` file or `meta.json`, use [SplatMesh](SplatMesh.md).

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

// Keep updating and rendering while waiting for the first data.
await streaming.firstRenderable;

// When removing the model:
// streaming.dispose();
// streaming.group.removeFromParent();
```

The three steps that matter:

1. Add `streaming.group` to the scene. Move, rotate, scale, or hide the scene through this group.
2. Register the camera.
3. Call `streaming.update()` before every render.

Streamed models support [SDF edits](SplatEdit.md) and [picking](SplatMesh.md#raycasting). Their data is read-only. Read a hit with `hit.object.splats.getSplat(hit.index)` before the streaming selection updates.

## Multiple inputs

Use `sources` instead of a top-level `url` to load several Streamed SOG inputs together:

```js
const streaming = new SogStreamScheduler({
  sources: [
    { url: "/scene/buildings/lod-meta.json" },
    { url: "/scene/landscape/lod-meta.json", environment: false },
  ],
  splatBudget: 3_000_000,
  maxConcurrentLoads: 4,
});
```

All inputs use the coordinates stored in their files, relative to `streaming.group`. They share one detail selection, splat budget, and loading concurrency. Set an input's `environment` to `false` to skip its environment. Enabled environments share the splat budget with all inputs' detail.

Each entry accepts the single-input loading options, including `loadChunk`, `manager`, `requestHeader`, and `withCredentials`; omitted options inherit the scheduler's settings. `sources` must be nonempty. Use separate schedulers for inputs that need independent transforms or budgets.

`initialized` waits for every input's metadata. `firstRenderable` resolves when the first selected data is displayed; it does not wait for every input to finish loading. `getBoundingBox()` and `stats` describe the combined scene.

## Cameras

Detail depends on distance and camera direction, so cameras need no resolution. Regions outside the view remain part of the same budget, with less detail behind the camera. This keeps surrounding content ready for turns, at the cost of some detail in the current view. Register several cameras to load detail for all of them; each region follows the camera requesting the finest detail.

Oversized region bounds are reduced toward the scene's median region size when measuring LOD distance. This prevents large background regions from receiving excessive detail just because an edge is close to the camera. Geometry, rendering bounds, and picking are unaffected by this distance correction.

### WebXR

In WebXR, register `renderer.xr.getCamera()` in place of your camera, as shown for [RadStreamScheduler](RadStreamScheduler.md#webxr). Detail is chosen for each eye.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `sources` | — | Multiple inputs sharing this scheduler; see [Multiple inputs](#multiple-inputs) |
| `url` | Required without `sources` | URL of the scene's `lod-meta.json` |
| `environment` | `true` | Load the input's environment; set to `false` to skip it. Also available on each `sources` entry |
| `splatBudget` | `3_000_000` | Splat budget, including the environment when enabled. Higher values allow more detail and use more memory |
| `maxSh` | `3` | Maximum SH degree to decode and store, an integer from `0` to `3`. Set at creation; `0` keeps only the base color |
| `splatBudgetMode` | `"target"` | `"target"` adjusts the distance bands to fill the budget. `"limit"` uses the configured distance bands and only reduces detail when they exceed the budget |
| `lodBaseDistance` | `100` | Base LOD distance in world units for `"limit"` mode, compensated for the camera's field of view. Higher values retain finer detail farther away. Must be finite and positive |
| `lodMultiplier` | `2` | Distance multiplier between successive LOD levels in both modes. Must be finite and at least `1` |
| `lodBehindPenalty` | `4` | Effective distance multiplier directly behind a camera, increasing smoothly from `1` at its sides. With the default LOD multiplier, `4` shifts rear detail by two distance bands. `1` disables directional bias. Must be finite and at least `1` |
| `lodDistanceShrink` | `0.75` | Fraction of a region's excess half-size above the scene median removed when measuring distance, independently on each axis. Higher values reduce detail in oversized regions; `0` disables the correction. Must be finite and between `0` and `1` |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long detail that is no longer shown stays in memory, ready for reuse; `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of loads in progress at the same time |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Headers and credentials are not sent to files on other origins |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |
| `loadChunk` | Built-in loader | Load the scene's files yourself: `(url, signal) => Promise<Splats>` |

## Properties and methods

| API | Description |
| --- | --- |
| `group` | Group created by this scheduler to hold the streamed scene |
| `splatBudget` | Change it at any time to adjust detail. Must be a positive integer; includes the environment when enabled |
| `maxSh` | Read-only SH decoding and storage limit chosen at creation |
| `splatBudgetMode` | Switch between `"target"` and `"limit"` without reloading |
| `lodBaseDistance` | Change the base LOD distance in `"limit"` mode without reloading |
| `lodMultiplier` | Change the distance spacing between LOD levels in both modes without reloading |
| `lodBehindPenalty` | Change how strongly detail behind the camera is reduced, in both modes, without reloading |
| `lodDistanceShrink` | Change the distance correction for oversized regions, in both modes, without reloading |
| `initialized` | Resolves when the index is loaded; rejects for invalid input |
| `firstRenderable` | Resolves when the first data is on screen, or the scene is empty; rejects if the first data cannot be loaded. Keep updating and rendering while you wait |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that chooses detail. `hasCamera(camera)` and `cameras` report the registered ones |
| `update()` | Advance detail selection, loading, and fades. Call it before every render; it throws if no camera is registered |
| `getBoundingBox()` | Box around the scene, in the group's coordinates; available once `initialized` resolves |
| `stats` | Visible Splats, loading progress, and estimated CPU/GPU cache sizes (`residentCpuBytes` / `residentGpuBytes`) |
| `dispose()` | Stop loading and release the scene. Pending `initialized` and `firstRenderable` promises reject with `AbortError` |

### On-demand rendering

Request a redraw from `onChange`, and keep calling `update()` on every animation tick, also when you skip the render. Loading, retries, and fades only make progress inside `update()`.

Each scheduler has a 24 MiB allowance for source texture layers waiting for GPU upload. Repeated `update()` calls do not renew it; rendering submits the queued layers and makes room for more data. A region larger than the allowance proceeds when no upload bytes are pending. Keep rendering while waiting for `firstRenderable`, even before any batches are visible. This allowance does not cap total CPU/GPU memory or uploads from other schedulers.

## Error recovery

Temporary download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried. Parts of the scene that are already on screen stay visible when loading more detail fails.

`firstRenderable` waits for the initial detail selection before deciding that all needed loads have failed permanently. An environment failure alone does not reject it while scene selection is pending.

If detail selection fails, the scheduler calls `onError`, stops loading, and retains the last displayed coverage while its fades finish. Create a new scheduler to try again, and call `dispose()` before discarding the old one.
