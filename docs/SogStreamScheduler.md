# SogStreamScheduler

[Back to documentation](../README.md#documentation)

Loads Streamed SOG `lod-meta.json` scenes with camera-driven LOD selection. Each chunk shares one `SplatMesh`; regions select LODs and fade independently. Supports version 1 and older unversioned indexes on WebGL and WebGPU.

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

Transform `streaming.group` to position, rotate or scale the scene. Streamed meshes support global sorting, SDF edits and raycasting; source records are read-only.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | Streamed SOG index URL |
| `group` | New `THREE.Group` | Parent for the scheduler's meshes |
| `splatBudget` | `3_000_000` | Target visible Splat count, including the environment |
| `cooldownTicks` | `100` | Updates to retain unused data after fade-out; `0` releases it immediately |
| `fadeDurationMs` | `200` | Visibility and LOD fade duration in milliseconds; `0` disables fades |
| `maxConcurrentLoads` | `4` | Maximum concurrent chunk downloads/decodes and decoding workers |
| `maxUploadBytesPerUpdate` | `8 MiB` | Estimated source upload allowance, including initial allocation; one oversized region or layer may proceed alone |
| `manager` | `THREE.DefaultLoadingManager` | Loading manager and URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Fetch settings; headers and credentials are not forwarded to cross-origin chunks |
| `onChange` | — | Redraw callback for data, visibility and fade changes |
| `onError` | Console error | Chunk failure callback: `(error, url)` |
| `loadChunk` | Built-in worker loader | Custom `(url, signal) => Promise<Splats>` loader |

The Splat budget is a target: fallback LODs, fades and the environment can exceed it. Pending copies have a separate byte limit; resident caches have no byte cap.

Chunks retain fixed source slots, while a compact index maps only regions with nonzero opacity into rendering, sorting and raycasting. Hidden slots and region padding do not contribute to the rendered count. The index is reused during fades and rebuilt when region visibility changes; chunk source storage remains cached independently.

A custom `loadChunk` must return initialized, independently owned data in its original count and order, and should honor the abort signal. Its arrays are consumed and transferred; do not reuse the returned `Splats`.

## Common properties and methods

| API | Description |
| --- | --- |
| `group` | Parent group for scene transforms |
| `initialized` | Resolves after index parsing; rejects on index errors |
| `firstRenderable` | Resolves when a region has nonzero opacity, or the dataset is empty; requires continued `update()` calls |
| `update(camera)` | Updates camera selection, loads, fades and cache retirement |
| `getBoundingBox()` | Group-local index bounds, available after initialization |
| `stats` | Visible/resident counts, resident and pending bytes, active loads, cumulative downloaded bytes and worker WASM peak memory |
| `dispose()` | Cancels requests, terminates streaming workers and releases owned meshes |

For on-demand rendering, use `onChange` to request redraws and keep calling `update()` each animation tick so fades and cache retirement advance. `cooldownTicks` counts updates, not seconds.

`pendingBytes` includes queued copies and reservations; `residentBytes` excludes them and WASM memory. Download totals include the index and chunks.

Index errors reject both readiness promises; chunk failures call `onError` and retry with backoff. There is no all-data-loaded promise for a camera-driven scene.
