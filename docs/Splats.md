# Splats

[Back to the API overview](../README.md#core-concepts-and-public-api)

`Splats` is the built-in mutable source. In addition to file input, it provides direct per-Splat access:

```js
const data = splat.splats;
const item = data.getSplat(0);
const itemWithoutSh = data.getSplat(0, false);

data.setSplat(
  0,
  item.center,
  item.scales.multiplyScalar(1.1),
  item.quaternion,
  item.opacity,
  item.color,
);

data.pushSplat(center, scales, quaternion, opacity, color);
data.removeSplat(0);
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

Choose at most one initialization input from `url`, `fileBytes`, `stream`, `splatArrays`, and `construct`; mixing them throws an error. Supplying `splatArrays` directly is a low-level encoded-data API.

`initialize()` returns the same promise exposed as `initialized`. File loading and `construct` callbacks run against staged data; if another `initialize()` call supersedes them, their completed state is discarded instead of replacing the newer data.

The main methods are:

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Asynchronous initialization state |
| `getNumSplats()` / `getNumSh()` | Returns Splat count and available SH degree |
| `getSplat(index, includeSh?)` | Decodes one Splat with SH coefficients by default; pass `false` to skip SH decoding |
| `setSplat(index, ...)` | Adds or overwrites one Splat |
| `pushSplat(...)` | Appends one Splat |
| `removeSplat(index)` | Removes one Splat and shifts subsequent indices down |
| `forEachCenter(callback)` | Iterates centers only, suitable for spatial-index construction |
| `forEachSplat(callback)` | Iterates and fully decodes every Splat |
| `ensureSplats(count)` | Ensures underlying array capacity |
| `initialize(options)` | Initializes or replaces data from a file, stream, array, or construction callback |
| `dispose()` | Releases textures and data references |

Decoded files provide `sortCenters` directly, avoiding a main-thread center-extraction pass before their first sort. After modifying low-level arrays such as `splatArrays` directly, set `data.needsUpdate = true`; this rebuilds the contiguous center cache on demand. Prefer `setSplat()`, `pushSplat()`, and `removeSplat()`, which keep both representations synchronized automatically.
