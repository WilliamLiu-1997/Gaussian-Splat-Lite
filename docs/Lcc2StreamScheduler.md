# Lcc2StreamScheduler

[Back to documentation](../README.md#documentation)

Loads LCC2 `0.0.x` scenes from a `.lcc2` index and its SOG, SPZ, or PLY files. Detail follows the registered cameras on WebGPU and WebGL2. Keep the scene's folder structure when hosting it or opening it in the viewer.

Data Organization Format originated from XGRIDS. See the [LCC2 white paper and format terms](https://github.com/xgrids/LCC2Whitepaper).

```js
import { Lcc2StreamScheduler } from "gaussian-splat-lite";

const streaming = new Lcc2StreamScheduler({
  splatBudget: 3_000_000,
  maxConcurrentLoads: 4,
});
scene.add(streaming.group);
streaming.setCamera(camera);
const sourceId = await streaming.addSource({ url: "/scene/meta.lcc2" });

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});

// Keep updating and rendering while waiting for visible data.
await streaming.firstRenderable;

// Remove one input, or dispose the entire scheduler when finished.
// streaming.removeSource(sourceId);
// streaming.dispose();
// streaming.group.removeFromParent();
```

`addSource()` resolves when metadata is ready. `firstRenderable` resolves when the scheduler displays data, or additions/removals leave an empty scene. It does not wait for all requested detail or reset after later additions.

## Detail and loading

Each region uses its own LOD data or is replaced by its children. Coarse data establishes coverage while finer data loads. A replacement is shown after all its regions are ready; loaded finer data can remain visible while a coarser replacement loads. Changes fade over `fadeDurationMs`.

`splatBudget` controls requested detail, including enabled environments. It is not a memory limit: coarse coverage, an environment larger than the budget, retained detail during loading, and fades can exceed it. Reducing `maxSh`, the budget, or `cooldownMs` can reduce memory use.

The scheduler shares the [SogStreamScheduler API](SogStreamScheduler.md):

- `addSource()`, `removeSource()`, `sourceIds`, `getSourceSettings()` and `setSourceSettings()` support independent inputs with stable IDs and a shared budget.
- Each input accepts `transform`, `environment`, `lodBaseDistance`, `lodMultiplier`, `manager`, `requestHeader`, `withCredentials`, and an optional `loadChunk` callback returning owned `Splats`.
- Register cameras with `setCamera()` and remove them with `deleteCamera()`. In WebXR, register `renderer.xr.getCamera()`; detail serves both eyes.
- Change `splatBudget`, `splatBudgetMode`, `lodBaseDistance`, `lodMultiplier`, or `lodBehindPenalty` without reloading.
- Read `stats` for loading, visible detail and memory estimates, and `getBoundingBox()` for group-local bounds.

Defaults match SOG streaming except `lodDistanceShrink`, which defaults to `0` for LCC2. `splatBudgetMode: "target"` adjusts detail toward the budget; `"limit"` treats the configured distance bands as the maximum detail. `maxSh` is fixed at creation and accepts `0`–`3`.

```js
const secondId = await streaming.addSource({
  url: "/second/meta.lcc2",
  transform: new THREE.Matrix4().makeTranslation(100, 0, 0),
  environment: false,
});
streaming.setSourceSettings(secondId, { lodBaseDistance: 50 });
```

Use separate SOG and LCC2 schedulers; their budgets are independent.

## Coordinates and scope

Data stays in the file's coordinate system. Set the group or input `transform` for your scene; the viewer defaults streamed scenes to Z-up and offers a source-axis override. Reserved metadata fields `offset`, `shift`, and `scale` are not applied automatically.

This loader displays Gaussian splats and the optional splat environment. Collision meshes, BVH files, virtual LOD generation, and rendering hints are not imported. LCC v1 `.lcc` files use a different format and are not supported by this scheduler.

Failures and cancellation follow [SOG streaming](SogStreamScheduler.md): transient requests retry, removing a source cancels its work, and a fatal selection error stops refinement while preserving already displayed data. The viewer accepts an HTTP(S) `.lcc2` URL or a local scene folder containing its index and companion files.
