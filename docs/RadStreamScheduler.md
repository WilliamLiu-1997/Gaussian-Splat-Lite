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

Transform `streaming.group` to position, rotate or scale the scene. Perspective, orthographic and `THREE.ArrayCamera` views are supported; array cameras use the greatest requested detail across eyes.

Nonempty streamed files require a LOD tree rooted at record zero. Files without a tree reject initialization with `error.name === "RadLodRequiredError"`; use `SplatMesh` instead. The Viewer handles this fallback automatically.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` / `file` / `fileBytes` | Exactly one required | URL, `Blob`/`File`, or complete `Uint8Array`/`ArrayBuffer` |
| `resolveFile` | Relative URL resolution | Companion-page resolver: `(filename, signal) => URL \| Blob \| Uint8Array \| ArrayBuffer`, optionally asynchronous |
| `group` | New `THREE.Group` | Parent for the scheduler's meshes |
| `splatBudget` | `3_000_000` | Maximum records in the selected LOD tree cut, before fade overlap |
| `cooldownTicks` | `100` | Updates to retain unused pages after fade-out; `0` releases eligible pages immediately |
| `fadeDurationMs` | `200` | Initial visibility and LOD fade duration in milliseconds; `0` switches immediately |
| `maxConcurrentLoads` | `4` | Maximum concurrent page downloads/decodes and decoding workers |
| `maxUploadBytesPerUpdate` | `8 MiB` | Estimated source upload allowance, including initial allocation; one oversized page may proceed alone |
| `manager` | `THREE.DefaultLoadingManager` | Loading manager and URL modifiers |
| `requestHeader` / `withCredentials` | `{}` / `false` | Request settings; sensitive settings are not forwarded to other origins |
| `onChange` | — | Redraw callback for data, visibility and fade changes |
| `onError` | Console error | Failure callback: `(error, url)` |

A parent stays visible until its complete replacement is resident. LOD changes crossfade between at most two cuts; shared nodes render once, but fade overlap can temporarily exceed `splatBudget`. With `fadeDurationMs: 0`, cuts switch immediately.

Pages retain fixed source slots while an index map selects visible records. Unused pages retire after `cooldownTicks`; pages needed by fades or traversal remain protected, and the root stays resident for fallback. Empty pools release their source storage.

Active loads and pending uploads have separate limits. `pendingBytes` includes queued copies and reservations; `residentBytes` excludes them and WASM memory. Resident storage has no byte cap; WASM peaks are reported separately.

## Common properties and methods

| API | Description |
| --- | --- |
| `group` | Parent group for scene transforms |
| `initialized` | Resolves after metadata and page setup; rejects on invalid input or unsupported streaming layout |
| `firstRenderable` | Resolves when a tree cut has nonzero opacity, or the dataset is empty; requires continued `update()` calls |
| `update(camera, viewport?)` | Advances selection, loads, fades and page retirement; viewport defaults to 1024 × 1024 |
| `getBoundingBox()` | New group-local box containing root bounds and selected Gaussian extents; approximate while streaming and empty until the root loads |
| `getGlobalIndex(mesh, renderedIndex)` | Maps a current batch index to the stable file-global node index |
| `stats` | Visible/resident counts, estimated resident and pending bytes, active loads, downloaded bytes, WASM peak memory, page budget and traversal time |
| `dispose()` | Aborts loads, terminates workers, releases pools and rejects pending readiness with `AbortError`; safe to call repeatedly |

For on-demand rendering, use `onChange` to request redraws and keep calling `update()` each animation tick so fades, retries and retirement advance. Do not await `firstRenderable` before starting the update loop. Header errors reject both readiness promises; page failures call `onError` and retry with backoff while needed. There is no all-pages-loaded promise.

Apply `group.matrixWorld` to `getBoundingBox()` for world-space camera framing. Bounds include both selected cuts during a fade.

Streamed meshes support global sorting, SDF edits and raycasting over selected records. Source data is read-only and streaming does not accept `postDecode`; use ordinary loading for persistent record edits.

```js
const hits = raycaster.intersectObject(streaming.group, true);
if (hits.length && hits[0].index !== undefined) {
  const nodeIndex = streaming.getGlobalIndex(hits[0].object, hits[0].index);
  console.log(nodeIndex, hits[0].point);
}
```

Resolve the global index while the hit's selection is current. A picked node may be an internal LOD representative, so refinement can change which node is picked.

## Hosting and local files

Monolithic HTTP streaming requires correct `206 Partial Content` responses with exact byte counts. Cross-origin hosts must allow CORS; expose `Content-Range` to enable offset and total-size validation. Avoid transparent compression that changes byte offsets. Hosts that ignore Range are rejected.

Split header-only `.rad` files and standalone `.radc` pages at offset zero can use bounded HTTP 200 responses. External pages embedded at nonzero offsets require Range.

For local split files, pass `file: header` and a `resolveFile` callback mapping metadata filenames to companion pages, as shown in [SplatLoader](SplatLoader.md#local-split-files). Preserve relative paths when metadata references subdirectories. The Viewer also accepts multi-file selection or drop.

## Ordinary loading

For models that fit in memory, use `new SplatMesh({ url: "/models/scene.rad" })`, `Splats` or [SplatLoader](SplatLoader.md). Ordinary loading decodes all pages and validates the complete LOD tree, retaining only leaves in original file order; files without a tree retain every record. `postDecode` runs on the retained records. SH degree is detected automatically; `mesh.maxSh` controls rendering without reducing decoded storage.

Ordinary loading rejects encoded input or estimated retained typed-array working storage above 2 GiB. Full loading can require substantially more memory than the final leaf arrays; use streaming for large scenes. RAD export and LOD-tree generation are not included.

URL loading uses random reads and page prefetch, with a bounded full-download fallback when Range is unavailable.
