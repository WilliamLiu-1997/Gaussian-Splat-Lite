# Lcc2StreamScheduler

[Back to documentation](../README.md#documentation)

Loads LCC2 `0.0.x` scenes from a `.lcc2` index and its SOG, SPZ, or PLY files, retaining up to SH4 by default. Detail follows the registered cameras on WebGPU and WebGL2. Keep the scene's folder structure when hosting it.

Data Organization Format originated from XGRIDS. See the [LCC2 white paper and format terms](https://github.com/xgrids/LCC2Whitepaper).

```js
import { Lcc2StreamScheduler } from "gaussian-splat-lite";

const streaming = new Lcc2StreamScheduler({
  splatBudget: 3_000_000,
});
scene.add(streaming.group);
streaming.setCamera(camera);
const sourceId = await streaming.addSource({ url: "/scene/meta.lcc2" });

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

Use a scene-level [SplatEditBlind](SplatEditBlind.md) edit to select SOG v3 Blind fields in current and future chunks. Set `blindData: false` if you do not need them: Blind data otherwise adds upload and memory cost to every chunk.

For SOG chunks, `hit.object.splats.extra` holds the application-defined `extras` of that chunk's `meta.json`, for example to look up what a Blind ID means; see [Splats](Splats.md). `splats.sceneExtra` is not used for LCC2.

## Detail and loading

The scene first appears at coarse detail and refines as finer data loads. Detail already on screen stays visible until its replacement is ready, and changes fade over `fadeDurationMs`.

`splatBudget` sets how much detail is requested, environments included. It is not a hard limit: the visible count can exceed it, for example during loading and fades or with a large environment. To use less memory, reduce `maxSh`, the budget, or `cooldownMs`.

## Multiple inputs

Create an empty scheduler, then add inputs individually or concurrently:

```js
const streaming = new Lcc2StreamScheduler({
  splatBudget: 3_000_000,
  maxConcurrentLoads: 4,
});
const [buildingsId, landscapeId] = await Promise.all([
  streaming.addSource({
    url: "/scene/buildings/meta.lcc2",
    lodBaseDistance: 100,
  }),
  streaming.addSource({
    url: "/scene/landscape/meta.lcc2",
    environment: false,
    lodBaseDistance: 20,
    lodMultiplier: 3,
  }),
]);
```

Each input can set `transform: THREE.Matrix4` to place its model relative to `streaming.group`; omitting it uses the identity. The matrix must be finite and invertible. The same URL can appear more than once as independent instances. The inputs share one detail selection, splat budget, budget mode, and chunk loading concurrency, while `lodBaseDistance` and `lodMultiplier` can differ per input; omitted ones follow the scheduler's values. Set an input's `environment` to `false` to skip its environment. Enabled environments share the splat budget with all inputs' detail.

Each `addSource()` call supplies its own `url`, `loadChunk`, `manager`, `requestHeader`, and `withCredentials` options. Use separate schedulers for inputs that need independent budgets. SOG and LCC2 scenes also use separate schedulers; their budgets are independent.

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
  url: "/scene/new-building/meta.lcc2",
  transform: new THREE.Matrix4().makeTranslation(120, 0, 0),
});

streaming.removeSource(buildingId); // Returns true; false if already absent.
```

`addSource()` resolves to the source ID when metadata is ready; other inputs keep displaying their loaded data. A failed addition rejects its promise, calls `onError`, and removes only that input. Call `addSource()` again to retry.

`removeSource(id)` immediately removes that input, cancels its requests, and releases its data. `sourceIds` includes pending additions; removing one rejects its promise with `AbortError`. An empty scheduler accepts new additions.

`firstRenderable` stays pending after construction until data is displayed or additions/removals leave an empty scene. It does not wait for every input or reset for later additions. Keep updating and rendering while waiting. Await `addSource()` for metadata; there is no `initialized` promise.

## Cameras

Detail depends on distance and camera direction, so cameras need no resolution. Regions outside the view remain part of the same budget, with less detail behind the camera. This keeps surrounding content ready for turns, at the cost of some detail in the current view. Register several cameras to load detail for all of them; each region follows the camera requesting the finest detail.

Unusually large regions, such as backgrounds, can get more detail than they need whenever one of their edges is near the camera. Raise `lodDistanceShrink`, which is off by default for LCC2, to correct for this; it changes only the chosen detail, not what is drawn or picked.

### WebXR

In WebXR, register `renderer.xr.getCamera()` in place of your camera, as shown for [RadStreamScheduler](RadStreamScheduler.md#webxr). Detail is chosen for each eye.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `splatBudget` | `3_000_000` | Splat budget, including the environment when enabled. Higher values allow more detail and use more memory |
| `maxSh` | `4` | Maximum SH degree to decode and store, an integer from `0` to `4`. Set at creation; `0` keeps only the base color |
| `blindData` | `true` | Load SOG v3 Blind data for [SplatEditBlind](SplatEditBlind.md). Set at creation; `false` skips its decoding and storage with the built-in loader |
| `splatBudgetMode` | `"target"` | `"target"` refines detail across inputs toward the budget. `"limit"` caps detail at the configured distance bands and reduces it when needed to fit the budget |
| `lodBaseDistance` | `100` | Default base LOD distance in world units, compensated for the camera's field of view. Sets the requested detail in `"limit"` mode and the relative detail between inputs in `"target"` mode. Must be finite and positive |
| `lodMultiplier` | `2` | Default distance multiplier between successive LOD levels in both modes. Must be finite and at least `1` |
| `lodBehindPenalty` | `5` | Content directly behind a camera is treated as this many times farther away, easing off toward its sides. `1` treats all directions alike. Must be finite and at least `1` |
| `lodDistanceShrink` | `0` | How strongly detail is reduced in regions much larger than the others of their input, from `0` (off) to `1` |
| `fadeDurationMs` | `200` | Duration of the fade when the scene first appears and when detail changes; `0` switches instantly |
| `cooldownMs` | `2000` | How long detail that is no longer shown stays in memory, ready for reuse; `0` releases it at once |
| `maxConcurrentLoads` | `4` | Maximum number of chunk downloads/decodes in progress at the same time; input metadata loads independently |
| `onChange` | — | Called when the scene needs a redraw |
| `onError` | Logs to the console | Called when loading fails: `(error, url)` |

Each `addSource(options)` call accepts:

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | URL of the scene's `.lcc2` index |
| `transform` | Identity | Input placement in the group's coordinates, as a finite, invertible `THREE.Matrix4` |
| `environment` | `true` | Load the input's environment; set to `false` to skip it |
| `lodBaseDistance` | Scheduler value | Override the base LOD distance for this input. Must be finite and positive |
| `lodMultiplier` | Scheduler value | Override the distance multiplier for this input. Must be finite and at least `1` |
| `manager` | `THREE.DefaultLoadingManager` | Three.js loading manager, including its URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings. Headers and credentials are not sent to files on other origins |
| `loadChunk` | Built-in loader | Load chunk files yourself: `(url, signal) => Promise<Splats>`. The scheduler takes ownership of the returned data |

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

Temporary chunk download failures are retried automatically, waiting longer after each attempt, up to 30 seconds. This covers network errors and HTTP 408, 425, 429, and 5xx responses. Each retry calls `onChange`, so an on-demand render loop resumes loading when the connection returns.

Invalid data, out-of-memory errors, and other HTTP errors are reported to `onError` and are not retried. Parts of the scene that are already on screen stay visible when loading more detail fails.

`firstRenderable` rejects only when nothing needed for the first image can be loaded.

If the scheduler can no longer choose detail, it calls `onError`, stops loading, and keeps showing what is on screen. Create a new scheduler to try again, and call `dispose()` on the old one.

## Coordinates and scope

Data stays in the file's coordinate system; orient and place it with the group or the input's `transform`. The index's `offset`, `shift`, and `scale` fields are not applied for you.

This loader displays Gaussian splats and the optional splat environment. Collision meshes, BVH files, virtual LOD generation, and rendering hints are not imported. LCC v1 `.lcc` files use a different format and are not supported by this scheduler.
