# Splats

[Back to documentation](../README.md#documentation)

`Splats` holds the data of a loaded model. Every `SplatMesh` has one as `mesh.splats`. Use it to read individual Splats, or to share one model's data between meshes.

Wait for loading to finish before reading:

```js
await splat.initialized;
const data = splat.splats;
const item = data.getSplat(0);
const sourceIndex = data.getSourceIndex(0);
```

## Options

The constructor and `initialize()` accept `SplatsOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `undefined` | PLY/SPZ/SOG/RAD file or SOG `meta.json` URL |
| `file` | `Blob` (including `File`) | `undefined` | Local file |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | Complete file data in memory |
| `fileType` | `SplatFileType` | Detected from the name | Set the format explicitly |
| `fileName` | `string` | `File.name` when available | Name used to detect the format |
| `resolveFile` | `SplatFileResolver` | `undefined` | Supply the extra files of a split SOG or RAD model; see [local split files](SplatLoader.md#local-split-files) |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | [Change each Splat while loading](PostDecode.md) |
| `onProgress` | `(event: SplatProgressEvent) => void` | `undefined` | [Loading progress](SplatLoader.md#loading-progress) callback |

Choose at most one of `url`, `file`, or `fileBytes`; combining them throws.

## Methods

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Promise that resolves when loading finishes, and whether it has |
| `initialize(options)` | Load new data from a URL, file, or bytes, replacing what was there. Returns the new `initialized` promise |
| `getNumSplats()` / `getNumSh()` | Splat count, and the level of view-dependent color (spherical harmonics degree) the model has |
| `getByteLength()` | Memory used by the data, in bytes |
| `getSplat(index, includeSh?)` | Read one Splat; pass `false` to skip its view-dependent color |
| `getSourceIndex(index)` | The Splat's ID in the original file |
| `forEachCenter(callback)` | Visit only the center of every Splat, for example to build a spatial index |
| `forEachSplat(callback)` | Visit every Splat |
| `dispose()` | Cancel loading and release the data |

Calling `initialize()` again or `dispose()` cancels a load still in progress; its promise rejects with `AbortError`.

## Data rules

- **Indices are not file order.** Splats are reordered while loading. Use `getSourceIndex(index)`, or a picking hit's `sourceIndex`, to get the ID from the original file. Passing existing `Splats` to a mesh keeps their order.
- **Reads return copies.** `getSplat()` returns new `center`, `scales`, `quaternion`, `opacity`, `color`, and `sh` values on each call; changing them does not change the model. `sh` holds 0, 3, 8, or 15 RGB coefficients, depending on the model's degree.
- **`forEachSplat()` reuses its objects.** The same objects are passed for every Splat, so clone anything you want to keep after the callback returns.
- **Streamed data is read-only.** Data from [RadStreamScheduler](RadStreamScheduler.md) or [SogStreamScheduler](SogStreamScheduler.md) cannot be reinitialized.
- **Bounds live on the mesh.** Use [`mesh.getBoundingBox()`](SplatMesh.md#bounding-box).

To change a model, use [postDecode](PostDecode.md) while loading, or [SplatMesh properties](SplatMesh.md#properties) and [SDF edits](SplatEdit.md) for display color and opacity.

## After reloading data

Data loaded with `initialize()` appears once the renderer has processed it. On WebGL this can take a few frames, and the previous data stays on screen meanwhile.

With [on-demand rendering](GaussianSplatRenderer.md#on-demand-rendering), request a redraw when `initialized` resolves, and connect `onDirty` to the same render request. With `autoUpdate: false`, await `splatRenderer.update({ scene, camera })` before rendering.

For loading progress, cancellation, and split files, see [SplatLoader](SplatLoader.md).
