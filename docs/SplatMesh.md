# SplatMesh

[Back to documentation](../README.md#documentation)

A Splat model in your scene. `SplatMesh` is a `THREE.Object3D`, so position, rotation, scale, visibility, layers, and children work as usual.

```js
import { SplatMesh } from "gaussian-splat-lite";

const splat = new SplatMesh({ url: "/assets/model.spz" });
scene.add(splat);
await splat.initialized;
```

## Loading

Use `url` for a remote file. For a local PLY, SPZ, SOG, or RAD file:

```js
const file = fileInput.files[0];
const splat = new SplatMesh({ file });
scene.add(splat);
await splat.initialized;
```

`file` accepts a `File` or `Blob`. For data already in memory, use `fileBytes`. The format is detected from the file name; pass `fileName` or [`fileType`](SplatFileType.md) when there is no name to go by.

Splats are reordered while loading, so their indices differ from the order in the file; see [data rules](Splats.md#data-rules).

For large streamed scenes, use [RadStreamScheduler](RadStreamScheduler.md) or [SogStreamScheduler](SogStreamScheduler.md) instead.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `undefined` | PLY/SPZ/SOG/RAD file or SOG `meta.json` URL |
| `file` | `Blob` (including `File`) | `undefined` | Local file |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | Complete file data in memory |
| `fileType` | `SplatFileType` | Detected from the name | Set the format explicitly: `PLY`, `SPZ`, `SOG`, or `RAD` |
| `fileName` | `string` | `File.name` when available | Name used to detect the format |
| `resolveFile` | `SplatFileResolver` | `undefined` | Supply the extra files of a split SOG or RAD model; see [local split files](SplatLoader.md#local-split-files) |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | [Change each Splat while loading](PostDecode.md) |
| `splats` | `Splats` | New `Splats` | Use existing [Splats](Splats.md) data instead of loading |
| `onProgress` | `(event: SplatProgressEvent) => void` | `undefined` | [Loading progress](SplatLoader.md#loading-progress) callback |
| `onLoad` | `(mesh) => void \| Promise<void>` | `undefined` | Called when loading completes |
| `onFrame` | `({ mesh, time, deltaTime }) => void` | `undefined` | Called before each update of the model; use it for animation |
| `editable` | `boolean` | `true` | Allow [SDF edits](SplatEdit.md) to affect this model |
| `raycastable` | `boolean` | `true` | Include this model in Three.js raycasting |
| `minRaycastOpacity` | `number` | `0.15` | Ignore more transparent areas when picking; higher values narrow the area that can be hit |

Choose at most one of `url`, `file`, `fileBytes`, or `splats`; combining them throws.

## Properties

| Property | Type / default | Description |
| --- | --- | --- |
| `initialized` | `Promise<SplatMesh>` | Resolves when loading and the `onLoad` callback have finished |
| `isInitialized` | `boolean` | Whether loading has finished |
| `numSplats` | `number` | Current Splat count |
| `recolor` | `THREE.Color(1, 1, 1)` | Color multiplier for the whole model |
| `opacity` | `1` | Opacity multiplier for the whole model |
| `maxSh` | `3` | Limit view-dependent color detail; `0` uses the base color only |
| `edits` | `SplatEdit[] \| null` | Explicit list of [edits](SplatEdit.md) for this mesh |
| `splats` | `Splats \| undefined` | The model's [Splats](Splats.md) data |
| `needsUpdate` | `boolean` setter | Set to `true` to force a refresh |

Changes to the transform, `recolor`, `opacity`, `maxSh`, and edits are picked up automatically. If the mesh's `Splats` is loaded again, `initialized` and `isInitialized` follow the new load, and `onLoad` runs again when it finishes.

Lighting and shadows are provided by the optional [SplatLightingPlugin](Lighting.md). Configure a model through `lighting.setModelOptions(mesh, options)`; `castShadow` and `receiveShadow` also remain ordinary inherited Three.js properties.

## Methods

```ts
await mesh.initialized;

mesh.getBoundingBox();      // Box around the Splat centers.
mesh.getBoundingBox(false); // Box that also covers each Splat's size and shape.

mesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {});

mesh.dispose();
```

### Bounding box

`getBoundingBox()` returns a new `Box3` in the mesh's local space; the mesh must be initialized first. To avoid creating a box each time, pass one as the second argument: `mesh.getBoundingBox(true, target)`.

- Pass `false` to cover each Splat's full size instead of only its center. Nearly transparent Splats, with opacity below `0.01`, are left out.
- The box describes the loaded data. It does not follow renderer settings, `opacity`, streaming fades, or SDF edits.
- For streamed models, the box follows the detail that is currently shown. With RAD it can be somewhat larger.

For a box in world space, update the world matrix and apply `mesh.matrixWorld` to the result.

### Forcing an update

You rarely need these. They are for changes the mesh cannot detect by itself:

```ts
mesh.updateVersion();                 // Refresh the model and sort it again.
mesh.updateVersion({ sort: false });  // Refresh appearance only; keep the sort order.
mesh.updateMappingVersion();          // The Splat count changed.
```

### Disposing

`mesh.dispose()` also disposes its `Splats`, even data you supplied yourself. To keep the data for reuse:

```js
await mesh.initialized;
const data = mesh.splats;
mesh.removeFromParent();
mesh.splats = undefined;
mesh.dispose();
// Call data?.dispose() when nothing uses it anymore.
```

## Raycasting

Use the standard Three.js raycaster:

```js
const raycaster = new THREE.Raycaster();
raycaster.setFromCamera(pointer, camera);

const intersections = raycaster.intersectObject(splat);
if (intersections.length > 0) {
  console.log(intersections[0].point, intersections[0].distance);
}
```

- The model needs `raycastable: true`, the default. Picking may return nothing while the model is still being set up.
- Each hit has an `index`, for reading the Splat from the current data, and a `sourceIndex`, its ID in the original file (`SplatIntersection` in TypeScript).
- Values of `minRaycastOpacity` below `0.01` have limited effect: areas that transparent may not be pickable.
- Streamed models can be picked. Hits ignore their display fades, and an `index` can change as the shown detail changes. For RAD, `sourceIndex` is the node index within the whole file; for streamed SOG, it is the index within the chunk file the hit Splat was loaded from.

## Scene integration

Use `onFrame` for animation:

```js
const splat = new SplatMesh({
  url: "/assets/model.spz",
  onFrame: ({ mesh, time }) => { mesh.rotation.y = time * 0.2; },
});
scene.add(splat);
```

If `onFrame` throws, the error comes out of the render or `update()` call that ran it. Changes the callback already made are kept.

For GIS/ECEF scenes, keep the model's own coordinates small and put the large offset in the mesh transform. This preserves detail; precision already lost in the source file cannot be restored.

For models with `+Y` down and `+Z` forward, use `splat.quaternion.set(1, 0, 0, 0)` to turn them 180° around X.
