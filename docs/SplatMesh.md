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

To create Splats in code:

```js
const splat = new SplatMesh({
  constructSplats: (data) => {
    data.pushSplats([{
      center: new THREE.Vector3(0, 0, 0),
      scales: new THREE.Vector3(0.2, 0.1, 0.1),
      quaternion: new THREE.Quaternion(),
      opacity: 1,
      color: new THREE.Color(0x4f8cff),
    }]);
  },
});
scene.add(splat);
await splat.initialized;
```

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
| `maxSplats` | `number` | `0` | Initial capacity for programmatic construction; grows when necessary |
| `constructSplats` | `(splats) => void \| Promise<void>` | `undefined` | Populates `Splats` during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Download or file-reading progress callback |
| `onLoad` | `(mesh) => void \| Promise<void>` | `undefined` | Called after initialization completes |
| `editable` | `boolean` | `true` | Allow scene-wide and model-specific region edits |
| `raycastable` | `boolean` | `true` | Participates in Three.js raycasting |
| `minRaycastOpacity` | `number` | `0.15` | Ignore more transparent areas when picking; higher values narrow the hit area |
| `onFrame` | `({ mesh, time, deltaTime }) => void` | `undefined` | Called before each model update; use for animation |

Choose at most one of `url`, `file`, `fileBytes`, `splats`, or `constructSplats`; mixing inputs throws.

## Common properties

| Property | Type / default | Description |
| --- | --- | --- |
| `initialized` | `Promise<SplatMesh>` | Resolves after asynchronous loading and construction |
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

mesh.getBoundingBox();      // Centers only; faster.
mesh.getBoundingBox(false); // Includes rotated and scaled Splat bounds.

mesh.setSplats([index], [splat]);
mesh.pushSplats([splat]);
mesh.removeSplats([indexA, indexB]); // Compacts surviving Splat indices.
mesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {});

mesh.updateVersion();                 // Regenerate and re-sort.
mesh.updateVersion({ sort: false });  // Appearance only; reuse sorting.
mesh.updateMappingVersion();          // Count or mapping changed.
mesh.dispose();
```

Batch inputs contain `center`, `scales`, `quaternion`, `opacity`, `color`, and optional `sh` (0, 3, 8, or 15 coefficients for SH0/1/2/3). Bounds require initialization; mutation throws after disposal.

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
