# SplatMesh

[Back to the API overview](../README.md#core-concepts-and-public-api)

`SplatMesh` extends `THREE.Object3D`, so it supports the standard `position`, `quaternion`, `scale`, `visible`, `layers`, and parent/child hierarchy APIs.

```ts
new SplatMesh(options?: SplatMeshOptions)
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `undefined` | PLY/SPZ file URL |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | Complete file data in memory |
| `fileType` | `SplatFileType` | Inferred from name | Explicitly selects `PLY` or `SPZ` |
| `fileName` | `string` | `undefined` | Supplies a name for inferring the format of byte or stream input |
| `stream` | `ReadableStream` | `undefined` | Chunked input stream |
| `streamLength` | `number` | `undefined` | Exact input-stream byte length, used for progress and safe allocation validation |
| `splats` | `SplatSource` | New `Splats` | Uses an existing built-in or custom source |
| `maxSplats` | `number` | `0` | Initial capacity for programmatic construction; grows when necessary |
| `constructSplats` | `(splats) => void \| Promise<void>` | `undefined` | Populates `Splats` during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Download or stream decoding progress callback |
| `onLoad` | `(mesh) => void \| Promise<void>` | `undefined` | Called after initialization completes |
| `editable` | `boolean` | `true` | Applies global and local SDF edits |
| `raycastable` | `boolean` | `true` | Participates in Three.js raycasting |
| `minRaycastOpacity` | `number` | `0.05` | Per-Splat kernel-alpha threshold; clips the raycast hit area at this opacity, including special-shape Splats |
| `onFrame` | `({ mesh, time, deltaTime }) => void` | `undefined` | Called before Splat generation for a frame |

Normally, choose exactly one of `url`, `fileBytes`, or `stream`. The `splats` option is intended for advanced custom sources and should not be mixed with file input.

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
| `splats` | `SplatSource \| undefined` | Current underlying source |
| `needsUpdate` | `boolean` setter | Set to `true` to force Splat regeneration and depth re-sorting; `false` does nothing |

## Common methods

```ts
await mesh.initialized;

mesh.getBoundingBox();      // Centers only; faster.
mesh.getBoundingBox(false); // Includes rotated and scaled Splat bounds.

mesh.pushSplat(center, scales, quaternion, opacity, color);
mesh.forEachSplat((index, center, scales, quaternion, opacity, color) => {});

mesh.updateVersion();                 // Regenerate and re-sort.
mesh.updateVersion({ sort: false });  // Appearance only; reuse sorting.
mesh.updateMappingVersion();          // Count or mapping changed.
mesh.dispose();
```

`getBoundingBox()` can only be called after initialization. `pushSplat()` only affects a mesh backed by the built-in `Splats` source.

## Raycasting

`SplatMesh` implements the Three.js `raycast()` protocol:

```js
const raycaster = new THREE.Raycaster();
raycaster.setFromCamera(pointer, camera);

const intersections = raycaster.intersectObject(splat);
if (intersections.length > 0) {
  console.log(intersections[0].point, intersections[0].distance);
}
```

Raycasting currently requires the built-in `Splats` source and `raycastable: true`. During the earliest stage of module startup, raycasting temporarily returns no intersections until the main-thread WebAssembly instance is ready.
