# RadStreamScheduler

[Back to documentation](../README.md#documentation)

Loads large RAD scenes with detail that adapts as the camera moves. Supports RAD version 1 with levels of detail (LOD), as a single `.rad` file or split files with `.radc` companions. Works on WebGL2 and WebGPU without a Spark runtime.

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

Use `streaming.group` to position, rotate, scale, or hide the scene. Streamed models support SDF edits and picking; their data is read-only.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` / `file` / `fileBytes` | Exactly one required | URL, `Blob`/`File`, or complete `Uint8Array`/`ArrayBuffer` |
| `resolveFile` | Relative URL resolution | Companion-page resolver: `(filename, signal) => URL \| Blob \| Uint8Array \| ArrayBuffer`, optionally asynchronous |
| `group` | New `THREE.Group` | Parent group for moving, rotating, scaling, or hiding the scene |
| `splatBudget` | `3_000_000` | Maximum selected Splat count before transition overlap |
| `cooldownTicks` | `100` | Updates to retain unused pages after fade-out; `0` releases eligible pages immediately |
| `fadeDurationMs` | `200` | Initial visibility and LOD fade duration in milliseconds; `0` switches immediately |
| `maxConcurrentLoads` | `4` | Maximum simultaneous loads |
| `maxUploadBytesPerUpdate` | `8 MiB` | Estimated data upload allowance per update; a large item may proceed alone |
| `manager` | `THREE.DefaultLoadingManager` | Loading manager and URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings; sensitive settings are not forwarded to other origins |
| `onChange` | — | Request a redraw when data or visibility changes |
| `onError` | Console error | Failure callback: `(error, url)` |

Existing detail stays visible while replacement detail loads. Fades can temporarily exceed `splatBudget`; use `fadeDurationMs: 0` to switch immediately. Cached data also uses memory, so the budget is not a total memory limit.

The upload allowance spreads loading work across updates. A large item may exceed it; it does not strictly cap every GPU upload in a frame.

## Common properties and methods

| API | Description |
| --- | --- |
| `group` | Parent group for moving, rotating, scaling, or hiding the scene |
| `splatBudget` | Positive safe integer; change it at runtime to adjust detail, even while the camera is stationary |
| `initialized` | Resolves when scene setup is ready; rejects invalid or unsupported input |
| `firstRenderable` | Resolves when the first data becomes visible, or the scene is empty; keep calling `update()` while waiting |
| `update(camera, viewport?)` | Update detail, loading, fades, and cleanup; viewport defaults to 1024 × 1024 |
| `getBoundingBox()` | Approximate bounds in group coordinates; empty until the first data loads |
| `getGlobalIndex(mesh, renderedIndex)` | Convert a picking result to a stable node index in the RAD file |
| `stats` | Visible and retained Splat data, loading progress, and memory estimates; not total browser memory |
| `dispose()` | Cancel loading and release scene resources; pending readiness promises reject with `AbortError` |

For on-demand rendering, use `onChange` to request redraws and keep calling `update()` each animation tick so loading, retries, fades, and cleanup progress.

```js
const hits = raycaster.intersectObject(streaming.group, true);
if (hits.length && hits[0].index !== undefined) {
  const nodeIndex = streaming.getGlobalIndex(hits[0].object, hits[0].index);
  console.log(nodeIndex, hits[0].point);
}
```
