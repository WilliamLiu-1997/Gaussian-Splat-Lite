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
| `streamLength` | `number` | `undefined` | Exact input-stream byte length, used for progress and safe allocation validation |
| `postDecode` | `SplatPostDecodeProgram` | `undefined` | Serializable per-Splat transform executed in the decode worker |
| `maxSplats` | `number` | `0` | Initial capacity |
| `splatArrays` | `[Uint32Array, Uint32Array]` | Empty arrays | Two pre-encoded Splat data arrays |
| `sortCenters` | `Float32Array` | Derived from `splatArrays` | Optional contiguous raw xyz centers paired with low-level encoded data |
| `numSplats` | `number` | Capacity | Number of valid Splats in `splatArrays` |
| `construct` | `(splats) => void \| Promise<void>` | `undefined` | Populates the source during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Loading progress callback |
| `extra` | `Record<string, unknown>` | `{}` | Additional data such as SH arrays |

Choose at most one initialization input from `url`, `fileBytes`, `stream`, `splatArrays`, and `construct`; mixing them throws an error. Supplying `splatArrays` directly is a low-level encoded-data API. Both arrays must have the same length and contain complete four-word records. Inputs that do not fill a texture row are padded automatically to the next compatible texture capacity without changing `numSplats`.

`initialize()` returns the same promise exposed as `initialized`. File loading and `construct` callbacks run against staged data; if another `initialize()` call supersedes them, their completed state is discarded instead of replacing the newer data.

The main methods are:

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Asynchronous initialization state |
| `getNumSplats()` / `getNumSh()` | Returns Splat count and available SH degree |
| `getSplat(index, includeSh?)` | Decodes one Splat with SH coefficients by default; pass `false` to skip SH decoding |
| `setSplats(indices, splats)` | Adds or overwrites Splats at the paired indices, including optional SH0/1/2/3 data |
| `pushSplats(splats)` | Appends a batch of Splats, including optional SH0/1/2/3 data |
| `removeSplats(indices)` | Removes the indexed Splats and compacts the surviving records in their original order |
| `forEachCenter(callback)` | Iterates centers only, suitable for spatial-index construction |
| `forEachSplat(callback)` | Iterates and fully decodes every Splat |
| `ensureSplats(count)` | Ensures underlying array capacity |
| `initialize(options)` | Initializes or replaces data from a file, stream, array, or construction callback |
| `dispose()` | Releases textures and data references |

Decoded files provide `sortCenters` directly, avoiding a main-thread center-extraction pass before their first sort. After modifying low-level arrays such as `splatArrays` directly, set `data.needsUpdate = true`; this rebuilds the contiguous center cache on demand. Prefer `setSplats()`, `pushSplats()`, and `removeSplats()`, which keep main records, SH records, and sort centers synchronized automatically. `setSplats()` requires equally sized index and Splat arrays. Removal indices may be unordered; duplicates are removed once. Every input Splat may omit `sh` for SH0 or provide exactly 3, 8, or 15 RGB coefficients for SH1, SH2, or SH3. Overwriting with a lower degree clears stale higher-degree coefficients for those records.
