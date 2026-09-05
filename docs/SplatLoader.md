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
