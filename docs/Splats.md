# Splats

[Back to documentation](../README.md#documentation)

`Splats` stores mutable Splat data. Wait for initialization before reading or editing:

```js
await splat.initialized;
const data = splat.splats;
const item = data.getSplat(0);

data.setSplats([0], [{
  ...item,
  scales: item.scales.multiplyScalar(1.1),
}]);
data.pushSplats([item]);
data.removeSplats([0, 2]);
```

## Options

The constructor and `initialize()` accept `SplatsOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `undefined` | PLY/SPZ/SOG/RAD file or SOG metadata URL |
| `file` | `Blob` (including `File`) | `undefined` | Local file |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | In-memory file data |
| `fileType` | `SplatFileType` | Inferred from name | Explicit file format |
| `fileName` | `string` | `File.name` when available | Name used to infer the input format |
| `resolveFile` | `SplatFileResolver` | `undefined` | Resolves external SOG images or RAD pages by metadata filename; see [local split files](SplatLoader.md#local-split-files) |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | Apply a [load-time transform](PostDecode.md) to each Splat |
| `maxSplats` | `number` | `0` | Initial capacity |
| `construct` | `(splats) => void \| Promise<void>` | `undefined` | Populates the source during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Loading progress callback |

Choose at most one of `url`, `file`, `fileBytes`, or `construct`; mixing inputs throws.

`initialize()` returns the new `initialized` promise and replaces earlier data. Reinitializing or disposing cancels pending file loading with `AbortError`. An existing construction callback may finish, but its result is ignored if a newer initialization has started.

## Methods

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Asynchronous initialization state |
| `getNumSplats()` / `getNumSh()` | Returns Splat count and available SH degree |
| `getByteLength()` | Return memory used by the retained data arrays |
| `extractRange(start, count)` | Copy a range into an independent, initialized, editable `Splats` |
| `getSplat(index, includeSh?)` | Read one Splat; pass `false` to skip spherical harmonics |
| `setSplats(indices, splats)` | Adds or overwrites Splats at the paired indices, including optional SH0/1/2/3 data |
| `pushSplats(splats)` | Appends a batch of Splats, including optional SH0/1/2/3 data |
| `removeSplats(indices)` | Remove Splats and shift later indices down, keeping their order |
| `forEachCenter(callback)` | Iterates centers only, suitable for spatial-index construction |
| `forEachSplat(callback)` | Visit every Splat |
| `initialize(options)` | Initializes or replaces data from a URL, file, bytes, or construction callback |
| `dispose()` | Cancel pending loading and release data resources |

## Data rules

- Use the methods above to read and edit data. Mutations keep Splat data, spherical harmonics, and sort centers synchronized.
- Each input has `center`, `scales`, `quaternion`, `opacity`, and `color`. Optional `sh` holds 0, 3, 8, or 15 RGB coefficients for SH0/1/2/3. Lower-degree overwrites clear stale coefficients.
- `setSplats()` requires equally sized index and Splat arrays. Removal indices may be unordered; duplicates are removed once.
- Streamed RAD/SOG data is read-only and cannot be reinitialized. Use `extractRange()` to make an editable copy.

Changes become visible after the renderer updates the data and any required sorting completes. Sorted WebGL rendering keeps the previous display while waiting for an asynchronous sort. For [on-demand rendering](GaussianSplatRenderer.md#on-demand-rendering), request a redraw after editing and connect `onDirty` to the same render scheduler. With `autoUpdate: false`, await `splatRenderer.update({ scene, camera })` before rendering.

For loading progress, cancellation, and companion files, see [SplatLoader](SplatLoader.md).
