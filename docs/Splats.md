# Splats

[Back to the API overview](../README.md#core-concepts-and-public-api)

`Splats` is the built-in mutable source. In addition to file input, it provides decoded reads and aligned batch mutation:

```js
const data = splat.splats;
const item = data.getSplat(0);
const itemWithoutSh = data.getSplat(0, false);

data.setSplats([0], [{
  ...item,
  scales: item.scales.multiplyScalar(1.1),
}]);

data.pushSplats([{
  center,
  scales,
  quaternion,
  opacity,
  color,
  sh, // Optional: 0, 3, 8, or 15 THREE.Color coefficients for SH0/1/2/3.
}]);
data.removeSplats([0, 2]);
data.forEachSplat((index, center, scales, quaternion, opacity, color) => {});
```

The constructor and `initialize()` accept the same `SplatsOptions`:

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

Choose at most one initialization input from `url`, `fileBytes`, `stream`, and `construct`; mixing them throws an error. Code-generated data should be added through `setSplats()` or `pushSplats()` so encoded records, spherical harmonics, and sort centers remain synchronized.

`initialize()` returns the same promise exposed as `initialized`. File loading and `construct` callbacks run against staged data; if another `initialize()` call supersedes them, their completed state is discarded instead of replacing the newer data.

The main methods are:

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

Decoded files provide sort centers directly, avoiding a main-thread center-extraction pass before their first sort. The encoded, sort-center, and SH array properties are private; use `getSplat()`, `forEachCenter()`, and `forEachSplat()` for application reads, and `setSplats()`, `pushSplats()`, and `removeSplats()` for mutation. `copySplatRecords()`, `copySortCenters()`, and `setTextureUniforms()` are low-level renderer integration methods; texture data assigned by `setTextureUniforms()` aliases source storage and must be treated as read-only. `setSplats()` requires equally sized index and Splat arrays. Removal indices may be unordered; duplicates are removed once. Every input Splat may omit `sh` for SH0 or provide exactly 3, 8, or 15 RGB coefficients for SH1, SH2, or SH3. Overwriting with a lower degree clears stale higher-degree coefficients for those records.
