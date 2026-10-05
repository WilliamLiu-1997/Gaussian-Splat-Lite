# SplatLoader

[Back to documentation](../README.md#documentation)

`SplatLoader` works like other Three.js loaders. It loads a model as [Splats](Splats.md) data, and `parse()` turns that data into a `SplatMesh` for your scene. The format is detected automatically.

```js
import { SplatLoader } from "gaussian-splat-lite";

const loader = new SplatLoader();
const decoded = await loader.loadAsync("/assets/model.spz", (event) => {
  console.log(event.stage, event.loaded, event.total);
});

const splat = loader.parse(decoded);
scene.add(splat);
```

The callback form matches the usual Three.js pattern:

```js
loader.load(
  "/assets/model.ply",
  (decoded) => scene.add(loader.parse(decoded)),
  (event) => console.log(event.stage, event.loaded, event.total),
  (error) => console.error(error),
);
```

If you do not need the loader API, `new SplatMesh({ url })` loads a model in one step; see [SplatMesh](SplatMesh.md).

For large RAD scenes with levels of detail, use [RadStreamScheduler](RadStreamScheduler.md). For SOG `lod-meta.json` scenes, use [SogStreamScheduler](SogStreamScheduler.md).

## Cancel loading

`loadAsync(url, onProgress?, signal?)` accepts an optional `AbortSignal`:

```js
const controller = new AbortController();
const loading = loader.loadAsync("/assets/model.sog", undefined, controller.signal);
controller.abort(); // `loading` rejects with the signal's reason.
```

`loader.abort()` cancels every load the loader has in progress; loads started afterwards are not affected. For a `Splats` or `SplatMesh` that is still loading, call its `dispose()`.

## Loading progress

`onProgress` receives a `SplatProgressEvent`: a standard `ProgressEvent` with an extra `stage` field. `Splats` and `SplatMesh` report progress the same way.

| `stage` | `loaded` / `total` |
| --- | --- |
| `download` | Bytes read or downloaded; `total === 0` means the size is unknown |
| `postDecode` | Splats processed by your [`postDecode`](PostDecode.md) program; skipped when none is set |
| `optimize` | Steps completed while preparing the model for rendering |

Progress starts again from zero for each stage. Use `event.loaded / event.total` when `event.lengthComputable` is true. It measures completed work, not time.

The model is ready when `loadAsync()` or `.initialized` resolves, which can be a little after the download reaches 100%.

## Local split files

A single `.sog` or `.rad` file needs only `file`. Some models are split across several files: a SOG `meta.json` with `.webp` images, or a RAD file with `.radc` pages. For these, pass the main file as `file` and supply the others through `resolveFile`:

```js
import { SplatMesh } from "gaussian-splat-lite";

const files = Array.from(fileInput.files);
const metadata = files.find((file) => file.name === "meta.json");
const byName = new Map(files.map((file) => [file.name, file]));
const mesh = new SplatMesh({
  file: metadata,
  resolveFile: (filename, signal) => {
    signal.throwIfAborted();
    const file = byName.get(filename);
    if (!file) throw new Error(`Missing companion file: ${filename}`);
    return file;
  },
});
scene.add(mesh);
await mesh.initialized;
```

`resolveFile` is called with each file name the model refers to. Return a URL, `Blob`, `Uint8Array`, or `ArrayBuffer`, directly or as a promise. If the model refers to files in subfolders, match those paths.
