# Splats

[Back to the API overview](../README.md#core-concepts-and-public-api)

`Splats` is the built-in mutable source. In addition to file input, it provides direct per-Splat access:

```js
const data = splat.splats;
const item = data.getSplat(0);

data.setSplat(
  0,
  item.center,
  item.scales.multiplyScalar(1.1),
  item.quaternion,
  item.opacity,
  item.color,
);

data.pushSplat(center, scales, quaternion, opacity, color);
data.forEachSplat((index, center, scales, quaternion, opacity, color) => {});
```

The constructor and `reinitialize()` accept the same `SplatsOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | `undefined` | PLY/SPZ file URL |
| `fileBytes` | `Uint8Array \| ArrayBuffer` | `undefined` | In-memory file data |
| `fileType` | `SplatFileType` | Inferred from name | Explicit file format |
| `fileName` | `string` | `undefined` | Name used to infer byte or stream input format |
| `stream` | `ReadableStream` | `undefined` | Chunked input stream |
| `streamLength` | `number` | `undefined` | Exact input-stream byte length, used for progress and safe allocation validation |
| `maxSplats` | `number` | `0` | Initial capacity |
| `splatArrays` | `[Uint32Array, Uint32Array]` | Empty arrays | Two pre-encoded Splat data arrays |
| `numSplats` | `number` | Capacity | Number of valid Splats in `splatArrays` |
| `construct` | `(splats) => void \| Promise<void>` | `undefined` | Populates the source during initialization |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` | Loading progress callback |
| `extra` | `Record<string, unknown>` | `{}` | Additional data such as SH arrays |

File input, `splatArrays`, and `construct` serve different initialization paths and normally should not be mixed. Supplying `splatArrays` directly is a low-level encoded-data API.

The main methods are:

| API | Description |
| --- | --- |
| `initialized` / `isInitialized` | Asynchronous initialization state |
| `getNumSplats()` / `getNumSh()` | Returns Splat count and available SH degree |
| `getSplat(index)` | Decodes and returns one Splat |
| `setSplat(index, ...)` | Adds or overwrites one Splat |
| `pushSplat(...)` | Appends one Splat |
| `forEachCenter(callback)` | Iterates centers only, suitable for spatial-index construction |
| `forEachSplat(callback)` | Iterates and fully decodes every Splat |
| `ensureSplats(count)` | Ensures underlying array capacity |
| `reinitialize(options)` | Reinitializes from a file, stream, array, or construction callback |
| `dispose()` | Releases textures and data references |

After modifying low-level arrays such as `splatArrays` directly, set `data.needsUpdate = true`. Prefer `setSplat()` and `pushSplat()`, which manage capacity and update state automatically.
