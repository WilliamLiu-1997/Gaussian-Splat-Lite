# SogStreamScheduler

[Back to documentation](../README.md#documentation)

Shows large SOG `lod-meta.json` scenes with camera-driven detail, keeping coarser surroundings ready as the camera turns. It supports version 1 and older unversioned indexes, on WebGPU and WebGL2. For an ordinary `.sog` file or `meta.json`, use [SplatMesh](SplatMesh.md).

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler({
  splatBudget: 3_000_000,
});
scene.add(streaming.group);
streaming.setCamera(camera);
const sourceId = await streaming.addSource({ url: "/scene/lod-meta.json" });

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});

// Keep updating and rendering while waiting for the first data.
await streaming.firstRenderable;

// Remove this input while keeping the scheduler available:
// streaming.removeSource(sourceId);

// When finished with the scheduler:
// streaming.dispose();
// streaming.group.removeFromParent();
```

To display a streamed scene:

1. Add `streaming.group` to the scene. Move, rotate, scale, or hide the scene through this group.
2. Register the camera.
3. Add each input with `streaming.addSource(options)`.
4. Call `streaming.update()` before every render.

Streamed models support [SDF edits](SplatEdit.md) and [picking](SplatMesh.md#raycasting). Their data is read-only. Read a hit with `hit.object.splats.getSplat(hit.index)` before the streaming selection updates.

## Multiple inputs

Create an empty scheduler, then add inputs individually or concurrently:

```js
const streaming = new SogStreamScheduler({
  splatBudget: 3_000_000,
  maxConcurrentLoads: 4,
});
const [buildingsId, landscapeId] = await Promise.all([
  streaming.addSource({
    url: "/scene/buildings/lod-meta.json",
    lodBaseDistance: 100,
  }),
  streaming.addSource({
    url: "/scene/landscape/lod-meta.json",
    environment: false,
    lodBaseDistance: 20,
    lodMultiplier: 3,
  }),
]);
```

Each input can set `transform: THREE.Matrix4` to place its model relative to `streaming.group`; omitting it uses the identity. The matrix must be finite and invertible. The same URL can appear more than once as independent instances. The inputs share one detail selection, splat budget, budget mode, and chunk loading concurrency, while `lodBaseDistance` and `lodMultiplier` can differ per input; omitted ones follow the scheduler's values. Set an input's `environment` to `false` to skip its environment. Enabled environments share the splat budget with all inputs' detail.

Each `addSource()` call supplies its own `url`, `loadChunk`, `manager`, `requestHeader`, and `withCredentials` options. Use separate schedulers for inputs that need independent budgets.

Each input has a stable numeric ID, assigned in addition order starting at `0`. Read the current IDs through `sourceIds`; deleting an input never renumbers other IDs, and IDs are never reused within a scheduler.

Change an input's `transform`, `environment`, `lodBaseDistance`, or `lodMultiplier` with `setSourceSettings(id, settings)`. Omitted keys keep their values, and `undefined` returns a LOD setting to the scheduler's value. Loaded data is kept. `getSourceSettings(id)` returns a copy of the current settings. Both methods throw for an unknown or removed ID.

```js
streaming.setSourceSettings(landscapeId, {
  transform: new THREE.Matrix4().makeTranslation(60, 0, 0),
  environment: true,
  lodBaseDistance: undefined,
});
```

Add or remove individual inputs at runtime:

```js
const buildingId = await streaming.addSource({
  url: "/scene/new-building/lod-meta.json",
  transform: new THREE.Matrix4().makeTranslation(120, 0, 0),
});

streaming.removeSource(buildingId); // Returns true; false if already absent.
```

`addSource()` resolves to the source ID when metadata is ready; other inputs keep displaying their loaded data. A failed addition rejects its promise, calls `onError`, and removes only that input. Call `addSource()` again to retry.

`removeSource(id)` immediately removes that input, cancels its requests, and releases its data. `sourceIds` includes pending additions; removing one rejects its promise with `AbortError`. An empty scheduler accepts new additions.

`firstRenderable` stays pending after construction until data is displayed or additions/removals leave an empty scene. It does not wait for every input or reset for later additions. Keep updating and rendering while waiting. Await `addSource()` for metadata; there is no `initialized` promise.

## Cameras

Detail depends on distance and camera direction, so cameras need no resolution. Regions outside the view remain part of the same budget, with less detail behind the camera. This keeps surrounding content ready for turns, at the cost of some detail in the current view. Register several cameras to load detail for all of them; each region follows the camera requesting the finest detail.

Oversized region bounds are reduced toward their input's median region size when measuring LOD distance. This prevents large background regions from receiving excessive detail just because an edge is close to the camera. Geometry, rendering bounds, and picking are unaffected by this distance correction.

### WebXR

In WebXR, register `renderer.xr.getCamera()` in place of your camera, as shown for [RadStreamScheduler](RadStreamScheduler.md#webxr). Detail is chosen for each eye.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `splatBudget` | `3_000_000` | Splat budget, including the environment when enabled. Higher values allow more detail and use more memory |
| `maxSh` | `3` | Maximum SH degree to decode and store, an integer from `0` to `3`. Set at creation; `0` keeps only the base color |
| `splatBudgetMode` | `"target"` | `"target"` scales all inputs' distance bands together to fill the budget. `"limit"` uses the configured distance bands and only reduces detail when they exceed the budget |
| `lodBaseDistance` | `100` | Default base LOD distance in world units, compensated for the camera's field of view. Sets the requested detail in `"limit"` mode and the relative detail between inputs in `"target"` mode. Must be finite and positive |
| `lodMultiplier` | `2` | Default distance multiplier between successive LOD levels in both modes. Must be finite and at least `1` |
| `lodBehindPenalty` | `4` | Effective distance multiplier directly behind a camera, increasing smoothly from `1` at its sides. With the default LOD multiplier, `4` shifts rear detail by two distance bands. `1` disables directional bias. Must be finite and at least `1` |
| `lodDistanceShrink` | `0.75` | Fraction of a region's excess half-size above its input's median removed when measuring distance, independently on each axis. Higher values reduce detail in oversized regions; `0` disables the correction. Must be finite and between `0` and `1` |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long detail that is no longer shown stays in memory, ready for reuse; `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of chunk downloads/decodes in progress at the same time; input metadata loads independently |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |

Each `addSource(options)` call accepts:

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | URL of the scene's `lod-meta.json` |
| `transform` | Identity | Input placement in the group's coordinates, as a finite, invertible `THREE.Matrix4` |
| `environment` | `true` | Load the input's environment; set to `false` to skip it |
| `lodBaseDistance` | Scheduler value | Override the base LOD distance for this input. Must be finite and positive |
| `lodMultiplier` | Scheduler value | Override the distance multiplier for this input. Must be finite and at least `1` |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Headers and credentials are not sent to files on other origins |
| `loadChunk` | Built-in loader | Load the scene's files yourself: `(url, signal) => Promise<Splats>` |

## Properties and methods

| API | Description |
| --- | --- |
| `group` | Group created by this scheduler to hold the streamed scene |
| `splatBudget` | Change it at any time to adjust detail. Must be a positive integer; includes the environment when enabled |
| `maxSh` | Read-only SH decoding and storage limit chosen at creation |
| `splatBudgetMode` | Switch between `"target"` and `"limit"` without reloading |
| `lodBaseDistance` | Change the default base LOD distance without reloading; inputs with their own value keep it |
| `lodMultiplier` | Change the default spacing between LOD levels without reloading; inputs with their own value keep it |
| `lodBehindPenalty` | Change how strongly detail behind the camera is reduced, in both modes, without reloading |
| `lodDistanceShrink` | Change the distance correction for oversized regions, in both modes, without reloading |
| `firstRenderable` | Readiness promise; see [Multiple inputs](#multiple-inputs) for its lifetime and [Error recovery](#error-recovery) for failures |
| `setCamera(camera)` / `deleteCamera(camera)` | Add or remove a camera that chooses detail. `hasCamera(camera)` and `cameras` report the registered ones |
| `sourceIds` | Snapshot of the current source IDs in insertion order, including pending additions |
| `addSource(options)` | Add an input; returns a promise of its stable ID when metadata is ready |
| `removeSource(id)` | Immediately cancel and release one input; returns whether it existed |
| `setSourceSettings(id, settings)` / `getSourceSettings(id)` | Change an input's `transform`, `environment`, `lodBaseDistance`, or `lodMultiplier` without reloading, or read a copy of its settings |
| `update()` | Advance detail selection, loading, and fades. Call it before every render; it throws if no camera is registered |
| `getBoundingBox()` | Box around the scene in the group's coordinates; includes each input once its `addSource()` promise resolves |
| `stats` | Visible Splats, loading progress, and estimated CPU/GPU cache sizes (`residentCpuBytes` / `residentGpuBytes`) |
| `dispose()` | Stop loading and release the scene. Pending readiness and addition promises reject with `AbortError` |

### On-demand rendering

Request a redraw from `onChange`, and keep calling `update()` on every animation tick, also when you skip the render. Loading, retries, and fades only make progress inside `update()`.

New data reaches the screen only when you render, so keep rendering while waiting for `firstRenderable`, even before anything is visible.

## Error recovery

Temporary download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried. Parts of the scene that are already on screen stay visible when loading more detail fails.

`firstRenderable` waits for the initial detail selection before deciding that all needed loads have failed permanently. An environment failure alone does not reject it while scene selection is pending.

If detail selection fails, the scheduler calls `onError`, stops loading, and retains the last displayed coverage while its fades finish. Create a new scheduler to try again, and call `dispose()` before discarding the old one.
