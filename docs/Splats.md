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
| `url` | `string` | `undefined` | PLY/SPZ file URL |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | In-memory file data |
| `fileType` | `SplatFileType` | Inferred from name | Explicit file format |
| `fileName` | `string` | `undefined` | Name used to infer byte or stream input format |
| `stream` | `ReadableStream` | `undefined` | Chunked input stream |
| `streamLength` | `number` | `undefined` | Optional input-stream byte-length estimate used for progress reporting |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | **`Experimental`** Serializable per-Splat transform executed in the decode worker |
| `maxSplats` | `number` | `0` | Initial capacity |
| `construct` | `(splats) => void \| Promise<void>` | `undefined` | Populates the source during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Loading progress callback |

Choose at most one of `url`, `fileBytes`, `stream`, or `construct`; mixing inputs throws.

`initialize()` returns `initialized`. A newer initialization supersedes earlier loading or construction results.

## Methods

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Asynchronous initialization state |
| `getNumSplats()` / `getNumSh()` | Returns Splat count and available SH degree |
| `getByteLength()` | Returns current retained bytes for encoded Splat, sort-center, and SH arrays |
| `getSplat(index, includeSh?)` | Decodes one Splat with SH coefficients by default; pass `false` to skip SH decoding |
| `setSplats(indices, splats)` | Adds or overwrites Splats at the paired indices, including optional SH0/1/2/3 data |
| `pushSplats(splats)` | Appends a batch of Splats, including optional SH0/1/2/3 data |
| `removeSplats(indices)` | Removes the indexed Splats and compacts the surviving records in their original order |
| `forEachCenter(callback)` | Iterates centers only, suitable for spatial-index construction |
| `forEachSplat(callback)` | Iterates and fully decodes every Splat |
| `initialize(options)` | Initializes or replaces data from a file, stream, or construction callback |
| `dispose()` | Releases textures and data references |

## Data rules

- Use the read and batch-mutation methods above; encoded arrays are private. Mutation keeps data, SH, and sort centers synchronized.
- Each input has `center`, `scales`, `quaternion`, `opacity`, and `color`. Optional `sh` holds 0, 3, 8, or 15 RGB coefficients for SH0/1/2/3. Lower-degree overwrites clear stale coefficients.
- `setSplats()` requires equally sized index and Splat arrays. Removal indices may be unordered; duplicates are removed once.
- `copySplatRecords()`, `copySortCenters()`, and `setTextureUniforms()` are low-level renderer methods. Texture data from `setTextureUniforms()` aliases source storage and is read-only.
