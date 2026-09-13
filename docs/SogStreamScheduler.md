# SogStreamScheduler

[Back to documentation](../README.md#documentation)

Loads large SOG `lod-meta.json` scenes with detail that adapts as the camera moves. Supports version 1 and older unversioned indexes on WebGL2 and WebGPU. For an ordinary `.sog` file or `meta.json`, use [SplatMesh](SplatMesh.md).

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler({
  url: "/scene/lod-meta.json",
  splatBudget: 3_000_000,
});
scene.add(streaming.group);
await streaming.initialized;

// Call each animation tick, before rendering.
streaming.update(camera);
renderer.render(scene, camera);

// When removing the model:
streaming.dispose();
streaming.group.removeFromParent();
```

Use `streaming.group` to position, rotate, scale, or hide the scene. Streamed models support SDF edits and picking; their data is read-only.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | Streamed SOG index URL |
| `group` | New `THREE.Group` | Parent group for moving, rotating, scaling, or hiding the scene |
| `splatBudget` | `3_000_000` | Target visible Splat count, including the environment |
| `cooldownMs` | `2000` | Milliseconds to retain unused data after fade-out; `0` releases eligible data immediately |
| `fadeDurationMs` | `200` | Visibility and LOD fade duration in milliseconds; `0` disables fades |
| `maxConcurrentLoads` | `4` | Maximum simultaneous loads |
| `maxUploadBytesPerUpdate` | `8 MiB` | Estimated data upload allowance per update; a large item may proceed alone |
| `manager` | `THREE.DefaultLoadingManager` | Loading manager and URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Fetch settings; headers and credentials are not forwarded to cross-origin chunks |
| `onChange` | — | Request a redraw when data or visibility changes |
| `onError` | Console error | Chunk failure callback: `(error, url)` |
| `loadChunk` | Built-in worker loader | Custom `(url, signal) => Promise<Splats>` loader |

The Splat budget is a target: available detail levels, fades, and the environment can exceed it. Cached data also uses memory, so the budget is not a total memory limit.

The upload allowance spreads loading work across updates. A large item may exceed it; it does not strictly cap every GPU upload in a frame.

## Common properties and methods

| API | Description |
| --- | --- |
| `group` | Parent group for moving, rotating, scaling, or hiding the scene |
| `splatBudget` | Positive safe integer including the environment; change it at runtime to adjust detail |
| `initialized` | Resolves when the index is ready; rejects invalid input |
| `firstRenderable` | Resolves when the first data becomes visible, or the scene is empty; keep calling `update()` while waiting |
| `update(camera)` | Update detail, loading, fades, and cleanup |
| `getBoundingBox()` | Group-local index bounds, available after initialization |
| `stats` | Visible and retained Splat data, loading progress, and memory estimates; not total browser memory |
| `dispose()` | Cancel loading and release scene resources; pending readiness promises reject with `AbortError` |

For on-demand rendering, use `onChange` to request redraws and keep calling `update()` each animation tick so loading, retries, fades, and cleanup progress.

Cooldown uses elapsed time, independent of update frequency. Expired data releases during updates or after accepted LOD decisions once no longer needed. Pending decisions defer cleanup so newly needed data can be reused; each accepted decision permits cleanup even during camera movement.
