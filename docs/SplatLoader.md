# SplatLoader

[Back to documentation](../README.md#documentation)

`SplatLoader` follows the Three.js `Loader` API. Load a model as `Splats` data, then use `parse()` to create a scene object.

```js
import { SplatLoader } from "gaussian-splat-lite";

const loader = new SplatLoader();
const decoded = await loader.loadAsync("/assets/model.spz", (event) => {
  console.log(event.loaded, event.total);
});

const splat = loader.parse(decoded);
scene.add(splat);
```

The callback form matches the normal Three.js Loader pattern:

```js
loader.load(
  "/assets/model.ply",
  (decoded) => scene.add(loader.parse(decoded)),
  (event) => console.log(event.loaded, event.total),
  (error) => console.error(error),
);
```

`loadAsync(url, onProgress?, signal?)` accepts an optional `AbortSignal`. Use it to cancel loading:

```js
const controller = new AbortController();
const loading = loader.loadAsync("/assets/model.sog", undefined, controller.signal);
controller.abort(); // `loading` rejects with the signal's reason.
```

For `Splats` or `SplatMesh`, call `dispose()` to cancel a pending load.

For large RAD scenes with levels of detail, use [RadStreamScheduler](RadStreamScheduler.md).
For `lod-meta.json` scenes, use [SogStreamScheduler](SogStreamScheduler.md).

## Local split files

Single `.sog` and `.rad` files need only `file`. For a local SOG `meta.json` with external `.webp` images, supply those images through `resolveFile`. The same option resolves external RAD `.radc` pages:

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

A resolver may return a URL, `Blob`, `Uint8Array`, or `ArrayBuffer`, directly or as a promise. For subfolders, match the paths referenced by the model.
