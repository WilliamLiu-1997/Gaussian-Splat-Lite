# SplatMesh

[Back to documentation](../README.md#documentation)

`SplatMesh` is a `THREE.Object3D` with standard transforms, visibility, layers, and children.

```ts
new SplatMesh(options?: SplatMeshOptions)
```

## Loading

Use `url` for remote files. For a local PLY/SPZ file:

```js
const file = fileInput.files[0];
const splat = new SplatMesh({
  fileName: file.name,
  stream: file.stream(),
  streamLength: file.size,
});
scene.add(splat);
await splat.initialized;
```

Files are decoded locally. For bytes, use `fileBytes: bytes` with `fileName` or `fileType`. A URL without a recognized extension also needs one of these format hints.

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
| `url` | `string` | `undefined` | PLY/SPZ file URL |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | Complete file data in memory |
| `fileType` | `SplatFileType` | Inferred from name | Explicitly selects `PLY` or `SPZ` |
| `fileName` | `string` | `undefined` | Supplies a name for inferring the format of byte or stream input |
| `stream` | `ReadableStream` | `undefined` | Chunked input stream |
| `streamLength` | `number` | `undefined` | Optional input-stream byte-length estimate used for progress reporting |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | **`Experimental`** Serializable per-Splat transform executed in the decode worker |
| `splats` | `Splats` | New `Splats` | Uses an existing `Splats` instance |
| `maxSplats` | `number` | `0` | Initial capacity for programmatic construction; grows when necessary |
| `constructSplats` | `(splats) => void \| Promise<void>` | `undefined` | Populates `Splats` during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Download or stream decoding progress callback |
| `onLoad` | `(mesh) => void \| Promise<void>` | `undefined` | Called after initialization completes |
| `editable` | `boolean` | `true` | Applies global and local SDF edits |
| `raycastable` | `boolean` | `true` | Participates in Three.js raycasting |
| `minRaycastOpacity` | `number` | `0.1` | Per-Splat kernel-alpha threshold; clips the raycast hit area at this opacity, including special-shape Splats |
| `onFrame` | `({ mesh, time, deltaTime }) => void` | `undefined` | Called before Splat generation for a frame |

Choose at most one of `url`, `fileBytes`, `stream`, `splats`, or `constructSplats`; mixing inputs throws.

## Common properties

| Property | Type / default | Description |
| --- | --- | --- |
| `initialized` | `Promise<SplatMesh>` | Resolves after asynchronous loading and construction |
| `isInitialized` | `boolean` | Whether initialization has completed |
| `numSplats` | `number` | Current Splat count |
| `recolor` | `THREE.Color(1, 1, 1)` | RGB multiplier applied to the entire object |
| `opacity` | `1` | Opacity multiplier applied to the entire object |
| `maxSh` | `3` | Maximum spherical-harmonic degree; use `0` for base color only |
| `edits` | `SplatEdit[] \| null` | Explicit edits applied only to this mesh |
| `splats` | `Splats \| undefined` | Current underlying Splat data |
| `needsUpdate` | `boolean` setter | Set to `true` to force Splat regeneration and depth re-sorting; `false` does nothing |

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

Requires the built-in `Splats` source and `raycastable: true`. Returns no hits until main-thread WebAssembly is ready.

## Scene integration

Use `onFrame` for animation:

```js
const splat = new SplatMesh({
  url: "/assets/model.spz",
  onFrame: ({ mesh, time }) => { mesh.rotation.y = time * 0.2; },
});
scene.add(splat);
```

For GIS/ECEF scenes, keep Splat centers local and put large offsets in the mesh transform. Rendering and sorting handle offsets in double precision; precision already lost in float32 source data cannot be recovered.

For models using `+Y` down and `+Z` forward, use `splat.quaternion.set(1, 0, 0, 0)` to rotate 180° around X.
