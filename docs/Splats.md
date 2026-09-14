# Splats

[Back to documentation](../README.md#documentation)

`Splats` stores decoded Splat data. Wait for initialization before reading:

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
| `url` | `string` | `undefined` | PLY/SPZ/SOG/RAD file or SOG metadata URL |
| `file` | `Blob` (including `File`) | `undefined` | Local file |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | In-memory file data |
| `fileType` | `SplatFileType` | Inferred from name | Explicit file format |
| `fileName` | `string` | `File.name` when available | Name used to infer the input format |
| `resolveFile` | `SplatFileResolver` | `undefined` | Resolves external SOG images or RAD pages by metadata filename; see [local split files](SplatLoader.md#local-split-files) |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | Apply a [load-time transform](PostDecode.md) to each Splat |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Loading progress callback |

Choose at most one of `url`, `file`, or `fileBytes`; mixing inputs throws.

`initialize()` returns the new `initialized` promise and replaces earlier data. Reinitializing or disposing cancels pending file loading with `AbortError`.

## Methods

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Asynchronous initialization state |
| `getNumSplats()` / `getNumSh()` | Returns Splat count and available SH degree |
| `getByteLength()` | Return memory used by the retained data arrays |
| `getSplat(index, includeSh?)` | Read one Splat; pass `false` to skip spherical harmonics |
| `getSourceIndex(index)` | Map a current data index to its original source ID |
| `forEachCenter(callback)` | Iterates centers only, suitable for spatial-index construction |
| `forEachSplat(callback)` | Visit every Splat |
| `initialize(options)` | Initializes or replaces data from a URL, file, or bytes |
| `dispose()` | Cancel pending loading and release data resources |

## Data rules

- File data is spatially reordered after `postDecode`; indices refer to the loaded order. Use `getSourceIndex(index)` or a picking hit's `sourceIndex` for the original source ID. Passing existing `Splats` to a mesh keeps their order.
- `getSplat()` returns `center`, `scales`, `quaternion`, `opacity`, `color`, and `sh` (0, 3, 8, or 15 RGB coefficients for SH0/1/2/3). Changing these returned values does not update the source.
- Streamed RAD/SOG data cannot be reinitialized.
- Read bounds through [`mesh.getBoundingBox()`](SplatMesh.md#common-methods). They update when data is reinitialized or the streaming selection changes.

Use [postDecode](PostDecode.md) to transform data at load time, or [SplatMesh properties](SplatMesh.md#common-properties) to adjust display color and opacity.

Reinitialized data becomes visible after the renderer updates it and any required sorting completes. Sorted WebGL rendering keeps the previous display while waiting for an asynchronous sort. For [on-demand rendering](GaussianSplatRenderer.md#on-demand-rendering), request a redraw after initialization and connect `onDirty` to the same render scheduler. With `autoUpdate: false`, await `splatRenderer.update({ scene, camera })` before rendering.

For loading progress, cancellation, and companion files, see [SplatLoader](SplatLoader.md).
