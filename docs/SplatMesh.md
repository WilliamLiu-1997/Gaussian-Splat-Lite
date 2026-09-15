# SplatMesh

[Back to documentation](../README.md#documentation)

`SplatMesh` is a `THREE.Object3D` with standard transforms, visibility, layers, and children.

```ts
new SplatMesh(options?: SplatMeshOptions)
```

## Loading

Use `url` for remote files. For a local PLY/SPZ/SOG/RAD file:

```js
const file = fileInput.files[0];
const splat = new SplatMesh({ file });
scene.add(splat);
await splat.initialized;
```

`file` accepts a `File` or `Blob`. For bytes, use `fileBytes: bytes`; `fileName` or `fileType` can supply an explicit format hint for any input.

Loaded indices may differ from file order; see [data rules](Splats.md#data-rules).

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `undefined` | PLY/SPZ/SOG/RAD file or SOG metadata URL |
| `file` | `Blob` (including `File`) | `undefined` | Local file |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | Complete file data in memory |
| `fileType` | `SplatFileType` | Inferred from name | Explicitly selects `PLY`, `SPZ`, `SOG`, or `RAD` |
| `fileName` | `string` | `File.name` when available | Supplies a name for inferring the input format |
| `resolveFile` | `SplatFileResolver` | `undefined` | Resolves external SOG images or RAD pages by metadata filename; see [local split files](SplatLoader.md#local-split-files) |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | Apply a [load-time transform](PostDecode.md) to each Splat |
| `splats` | `Splats` | New `Splats` | Uses an existing `Splats` instance |
| `onProgress` | `(event: SplatProgressEvent) => void` | `undefined` | [Per-stage loading progress](SplatLoader.md#loading-progress) callback |
| `onLoad` | `(mesh) => void \| Promise<void>` | `undefined` | Called after initialization completes |
| `editable` | `boolean` | `true` | Allow scene-wide and model-specific region edits |
| `raycastable` | `boolean` | `true` | Participates in Three.js raycasting |
| `minRaycastOpacity` | `number` | `0.15` | Ignore more transparent areas when picking; higher values narrow the hit area |
| `onFrame` | `({ mesh, time, deltaTime }) => void` | `undefined` | Called before each model update; use for animation |

Choose at most one of `url`, `file`, `fileBytes`, or `splats`; mixing inputs throws.

## Common properties

| Property | Type / default | Description |
| --- | --- | --- |
| `initialized` | `Promise<SplatMesh>` | Resolves after loading and the `onLoad` callback |
| `isInitialized` | `boolean` | Whether initialization has completed |
| `numSplats` | `number` | Current Splat count |
| `recolor` | `THREE.Color(1, 1, 1)` | RGB multiplier applied to the entire object |
| `opacity` | `1` | Opacity multiplier applied to the entire object |
| `maxSh` | `3` | Limit view-dependent color detail; `0` uses base color only |
| `edits` | `SplatEdit[] \| null` | Explicit edits applied only to this mesh |
| `splats` | `Splats \| undefined` | Current underlying Splat data |
| `needsUpdate` | `boolean` setter | Set to `true` to force a refresh; `false` does nothing |

## Common methods

```ts
await mesh.initialized;

mesh.getBoundingBox();      // Centers only.
mesh.getBoundingBox(false); // Includes scale, rotation and shape at alpha 0.01.

mesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {});

mesh.updateVersion();                 // Regenerate and re-sort.
mesh.updateVersion({ sort: false });  // Appearance only; reuse sorting.
mesh.updateMappingVersion();          // Count or mapping changed.
mesh.dispose();
```

Bounds require initialization. `getBoundingBox()` returns a new `Box3` in mesh-local space; pass `false` to include Splat scale, rotation and kernel shape at a fixed source-opacity threshold of `0.01`. Splats below this threshold are omitted from these expanded bounds. These bounds do not track renderer settings, mesh opacity, streaming fades or SDF edits. Pass an existing box as the second argument, `mesh.getBoundingBox(true, target)`, to reuse it and avoid allocating a new box. Bounds include zero-scale Splats that meet the opacity threshold and ignore non-finite centers. Streamed bounds follow the visible selection, but RAD bounds may also include unselected Splats.

For world-space bounds, update the world matrix and apply `mesh.matrixWorld` to the returned box.

`mesh.dispose()` also disposes its `Splats`, including caller-supplied data. To keep shared or reusable data:

```js
await mesh.initialized;
const data = mesh.splats;
mesh.removeFromParent();
mesh.splats = undefined;
mesh.dispose();
// Call data?.dispose() when no users need it anymore.
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

Requires `raycastable: true`. Picking may return no hits during initial setup. Streaming models can be picked, but hits do not follow their display fades.

Picking first checks cached block bounds at a fixed source-opacity threshold of `0.01`. Lowering `minRaycastOpacity` below `0.01` does not expand these bounds, so more transparent areas outside them cannot be picked.

Hits include `index` for reading the current Splat and `sourceIndex` for its original source ID (`SplatIntersection` in TypeScript). Streamed indices can change with the visible selection. RAD source IDs are file-global node indices; streamed SOG source IDs are indices within the hit batch's source chunk.

## Scene integration

Use `onFrame` for animation:

```js
const splat = new SplatMesh({
  url: "/assets/model.spz",
  onFrame: ({ mesh, time }) => { mesh.rotation.y = time * 0.2; },
});
scene.add(splat);
```

If `onFrame` throws, the current update stops and the error propagates through the renderer's update/render call. Changes already made by the callback are not rolled back.

For GIS/ECEF scenes, keep model coordinates local and put large offsets in the mesh transform. This helps preserve detail; precision already lost in the source file cannot be restored.

For models using `+Y` down and `+Z` forward, use `splat.quaternion.set(1, 0, 0, 0)` to rotate 180° around X.
