# SplatLoader

[Back to documentation](../README.md#documentation)

`SplatLoader` follows the Three.js `Loader` API style. It first returns decoded `Splats`; `parse()` then wraps that source in a `SplatMesh`.

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

`loadAsync(url, onProgress?, signal?)` accepts an optional `AbortSignal`. Cancellation also interrupts worker decoding:

```js
const controller = new AbortController();
const loading = loader.loadAsync("/assets/model.sog", undefined, controller.signal);
controller.abort(); // `loading` rejects with the signal's reason.
```

For loads started through `Splats` or `SplatMesh`, `dispose()` also cancels pending downloading and decoding.

For `lod-meta.json` scenes, use [SogStreamScheduler](SogStreamScheduler.md).

