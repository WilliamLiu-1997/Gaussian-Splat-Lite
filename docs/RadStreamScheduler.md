# RadStreamScheduler

[Back to documentation](../README.md#documentation)

Loads RAD scenes with camera-driven LOD selection and on-demand pages. Supports RAD version 1 (Spark v2.1.0), including single `.rad` containers and split headers with external `.radc` pages, on WebGL2 and WebGPU. No Spark runtime is required.

```js
import * as THREE from "three";
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler({
  url: "/models/scene.rad",
  splatBudget: 3_000_000,
});
scene.add(streaming.group);
await streaming.initialized;

const size = new THREE.Vector2();
renderer.setAnimationLoop(() => {
  renderer.getDrawingBufferSize(size);
  streaming.update(camera, { width: size.x, height: size.y });
  renderer.render(scene, camera);
});

// Requires update() to keep running.
await streaming.firstRenderable;

// When removing the model:
// streaming.dispose();
// streaming.group.removeFromParent();
```

Transform `streaming.group` to position, rotate or scale the scene. Streamed meshes support global sorting, SDF edits and raycasting; source records are read-only.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` / `file` / `fileBytes` | Exactly one required | URL, `Blob`/`File`, or complete `Uint8Array`/`ArrayBuffer` |
| `resolveFile` | Relative URL resolution | Companion-page resolver: `(filename, signal) => URL \| Blob \| Uint8Array \| ArrayBuffer`, optionally asynchronous |
| `group` | New `THREE.Group` | Parent for the scheduler's meshes |
| `splatBudget` | `3_000_000` | Maximum records in the selected LOD tree cut, before fade overlap |
| `cooldownTicks` | `100` | Updates to retain unused pages after fade-out; `0` releases eligible pages immediately |
| `fadeDurationMs` | `200` | Initial visibility and LOD fade duration in milliseconds; `0` switches immediately |
| `maxConcurrentLoads` | `4` | Maximum concurrent page downloads/decodes and decoding workers, separate from the LOD worker |
| `maxUploadBytesPerUpdate` | `8 MiB` | Estimated source upload allowance, including initial allocation; one oversized page may proceed alone |
| `manager` | `THREE.DefaultLoadingManager` | Loading manager and URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings; sensitive settings are not forwarded to other origins |
| `onChange` | — | Redraw callback for data, visibility and fade changes |
| `onError` | Console error | Failure callback: `(error, url)` |

A parent stays visible until its complete replacement is resident. Decoded pages reserve source slots before LOD selection; selected data is written before display. LOD changes crossfade between at most two cuts; shared nodes render once, but fade overlap can temporarily exceed `splatBudget`. With `fadeDurationMs: 0`, cuts switch immediately.

## Common properties and methods

| API | Description |
| --- | --- |
| `group` | Parent group for scene transforms |
| `splatBudget` | Read/write positive safe integer; changing it requests a new LOD selection |
| `initialized` | Resolves after metadata and page setup; rejects on invalid input or unsupported streaming layout |
| `firstRenderable` | Resolves when a tree cut has nonzero opacity, or the dataset is empty; requires continued `update()` calls |
| `update(camera, viewport?)` | Advances selection, loads, fades and page retirement; viewport defaults to 1024 × 1024 |
| `getBoundingBox()` | New group-local box containing root bounds and selected Gaussian extents; approximate while streaming and empty until the root loads |
| `getGlobalIndex(mesh, renderedIndex)` | Maps a current batch index to the stable file-global node index |
| `stats` | Visible/resident counts, estimated resident and pending bytes, active loads, downloaded bytes, WASM peak memory, page budget and LOD decision round-trip time (including diff/fade preparation) |
| `dispose()` | Aborts loads, terminates workers, releases pools and rejects pending readiness with `AbortError`; safe to call repeatedly |

For on-demand rendering, use `onChange` to request redraws and keep calling `update()` each animation tick so fades, retries and retirement advance. Pending LOD requests coalesce to the latest view while one traversal runs.

```js
const hits = raycaster.intersectObject(streaming.group, true);
if (hits.length && hits[0].index !== undefined) {
  const nodeIndex = streaming.getGlobalIndex(hits[0].object, hits[0].index);
  console.log(nodeIndex, hits[0].point);
}
```
