# LccStreamScheduler

[Back to documentation](../README.md#documentation)

Loads XGRIDS `.lcc` and `.lcc2` scenes with camera-dependent detail on WebGPU and WebGL2. Register a camera and call `update()` before rendering, as with the RAD/SOG schedulers.

```js
import { LccStreamScheduler } from "gaussian-splat-lite";

const streaming = new LccStreamScheduler({
  url: "/scene/model.lcc2", // or /scene/model.lcc
  splatBudget: 3_000_000,
  fadeDurationMs: 200,
});
scene.add(streaming.group);
streaming.setCamera(camera);
streaming.setResolutionFromRenderer(camera, renderer);
await streaming.initialized;

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});

// update() must keep running while this promise is pending.
await streaming.firstRenderable;

// On resize, refresh the CSS-pixel resolution:
// streaming.setResolutionFromRenderer(camera, renderer);
// On removal:
// streaming.dispose();
// streaming.group.removeFromParent();
```

The stored coordinates are preserved. XGRIDS scenes use Z-up; rotate `streaming.group.rotation.x = -Math.PI / 2` for a Y-up scene. The viewer applies this automatically. `offset`, `shift`, `scale`, and `epsg` remain metadata and do not apply a geographic transform.

## Detail and loading

The two formats have different refinement units:

| Format | Refinement | File access |
| --- | --- | --- |
| LCC | A fixed XY Unit switches its entire region between LODs | Read the Unit/LOD byte range from `data.bin`, and from `shcoef.bin` for Quality files |
| LCC2 | Replace one parent with its complete set of children; child regions become smaller | Decode the referenced SOG, SPZ, or PLY file once, then extract each node's `start`/`count` range in original file order |

By default, `splatBudgetMode: "target"` adds detail until the budget is full, starting where the detail rules below need it most, and up to eight times finer than those rules. `"limit"` stops at the rules and leaves the rest of the budget unused, as the [XGRIDS Web SDK 0.6.4](https://github.com/xgrids/LCC-Web-SDK/releases/tag/v0.6.4) does.

LCC uses 20-model-unit distance bands by default and the coarsest LOD beyond 200 units. Each Unit refines toward its band, nearest bands first. A Unit whose next LOD does not fit keeps its current LOD while the others continue, and no single LOD may take more than half the budget. In limit mode, the distance cutoff near the ground expands with camera height. As the SDK does, LCC excludes Units with fewer than 100 records across their LODs; it also does not display nodes with fewer than 50 records. It uses uniform LOD0, or LOD1, when that entire level fits. If all detail is excluded and the environment is absent or empty, `firstRenderable` resolves as an empty scene.

LCC2 uses a 40-pixel projected error threshold by default, with distance bands within 10 world units for perspective cameras. Orthographic cameras use projected error at every distance. Branches with the largest projected error refine first, moving beyond virtual preview LODs when possible. A replacement that does not fit keeps its branch coarser while others continue. Offscreen siblings stay coarse but remain available for complete parent replacement. If the finest-level scene fits the budget, visible branches use that level.

Coarse coverage loads first. A change of four or more levels first loads the level halfway there, as SOG does. LCC2 keeps its parent visible until its complete replacement is ready. Coarse coverage within 100 model units of a camera stays loaded while out of view, so turning shows coarse data at once. Replacements crossfade together, while unchanged regions retain full opacity. Independent regions can transition concurrently, and visibility fades reverse from their current opacity. Cached coverage is reused after hiding and showing the scene.

LCC2 retains prepared children and decoded files while a replacement is pending, avoiding repeated downloads at the cost of higher CPU memory use. A permanent sibling failure cancels the replacement and lets unused data expire after `cooldownMs`. LCC decoded byte ranges can expire independently of displayed regions.

The budget includes environment Splats. LCC drops distant Units if their coarsest levels still exceed the budget; LCC2 keeps complete coarse coverage even when it exceeds a very small budget. A fade temporarily holds both representations. The budget is not a hard memory limit. Moving through detailed areas downloads more data with a larger budget; lower it for slow connections.

## Inputs

- **LCC 3.0/5.0 COMPRESS:** `.lcc`, `index.bin`, `data.bin`, optional `environment.bin`, and `shcoef.bin` for Quality. Portable carries SH0; Quality carries SH3. LCC 3.0 without `fileType` is read as Quality. An absent `environment.bin` returning HTTP 404 is allowed.
- **LCC2 0.0.2/0.0.3:** `.lcc2` and the SOG, SPZ, or binary PLY files referenced by `root.splatFiles`, including available SH coefficients. Earlier `total_splats`/`root.files` indexes and virtual preview LODs are supported.
- Meshes, collision/BVH files, and extra semantic/instance attributes are not loaded. `renderingHints` does not override renderer settings.

Remote hosts must allow CORS. LCC requires HTTP byte ranges with a `206` response; servers that ignore `Range` are rejected before downloading the whole scene. Expose `Content-Range` and a strong `ETag` or `Last-Modified` through CORS to validate ranges and detect file changes across concurrent requests. Keep scene files unchanged during loading; without exposed validators, same-size changes cannot be detected. Relative companion paths resolve from the scene index; a leading `/` in an LCC2 file path remains relative to the model folder, matching XGRIDS.

For local scenes, drop the complete folder into the viewer or select the index with its companion files. Applications can provide a `THREE.LoadingManager` URL modifier to map logical scene URLs to local blobs. Set `environment: false` when omitting LCC environment data locally.

Index parsing runs in a worker. LoadingManager tracks initialization through parsing and reports invalid indexes through `onError`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | `.lcc` or `.lcc2` index URL |
| `group` | New `THREE.Group` | Transform, visibility, and layers of the streamed scene |
| `splatBudget` | `3_000_000` | Detail budget including environment Splats |
| `splatBudgetMode` | `"target"` | `"target"` fills the budget, up to eight times finer than `lodStepDistance` and `maxScreenSpaceError` ask for; `"limit"` stops at them |
| `lodStepDistance` | `20` | LCC distance between LOD bands, in model units; finite and positive. Orders detail, and limits it in limit mode |
| `maxScreenSpaceError` | `40` | LCC2 projected error threshold in CSS pixels; finite and positive. Orders detail, and limits it in limit mode |
| `environment` | `true` | Load environment Splats when present |
| `fadeDurationMs` | `200` | Initial and replacement fade duration; `0` switches instantly |
| `cooldownMs` | `2000` | Retain unused regions and decoded files for reuse |
| `maxConcurrentLoads` | `4` | Concurrent file downloads/decodes |
| `manager` | `THREE.DefaultLoadingManager` | Loading events and companion URL mapping |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings, restricted to the original index URL's origin, including after redirects |
| `onChange` | — | Request a redraw; keep calling `update()` even when rendering on demand |
| `onError` | Console logging | `(error, url)` for a failed load |

## Properties and methods

| API | Description |
| --- | --- |
| `initialized` | Resolves after index parsing |
| `firstRenderable` | Resolves when the first visible region is ready, or the scene is empty |
| `splatBudget`, `splatBudgetMode`, `lodStepDistance`, `maxScreenSpaceError` | Change detail settings without reloading |
| `setCamera(camera)` / `deleteCamera(camera)` | Register/remove a camera; `hasCamera(camera)` and `cameras` report registrations |
| `setResolution(camera, width, height)` | Set a registered camera's CSS-pixel resolution; also accepts `THREE.Vector2` |
| `setResolutionFromRenderer(camera, renderer)` | Read CSS-pixel size from the renderer; required for LCC2, optional for LCC |
| `update()` | Advance selection, loads, and fades before rendering; returns whether the displayed state changed |
| `getBoundingBox()` | Index bounds in group-local coordinates, available after `initialized` |
| `info` | Format, version, coordinate metadata, and per-level Splat counts |
| `stats` | Visible nodes/Splats/meshes, progress, downloads, and estimated CPU/GPU storage |
| `dispose()` | Cancel loading, remove streamed batches from the group, and release resources; pending readiness promises reject with `AbortError` |

Multiple cameras select detail together. For WebXR, register `renderer.xr.getCamera()`; eye poses and viewports drive selection after initialization. Transform the group to move the whole model. Streamed data supports SDF edits and picking but remains read-only. Read a hit with `hit.object.splats.getSplat(hit.index)` before the streaming selection updates; its index can change with the visible detail.

## Error recovery

Temporary network failures use the same retry/backoff policy as RAD/SOG. Invalid data and permanent HTTP errors are reported without retry; already displayed coverage remains visible. `firstRenderable` rejects if all needed loads fail permanently, after initial detail selection and any pending environment load.

If detail selection fails, the scheduler calls `onError`, stops loading, and retains the last displayed coverage while its fades finish. Create a new scheduler to try again. Call `dispose()` before discarding the old scheduler.

## Format attribution

**Data Organization Format originated from XGRIDS.** See the [LCC white paper](https://github.com/xgrids/LCCWhitepaper) and [LCC2 white paper](https://github.com/xgrids/LCC2Whitepaper) for the format specifications and their licensing terms. Applications using these formats must retain the visible attribution required by those terms. This is an independent reader; the XGRIDS SDK is not bundled.
