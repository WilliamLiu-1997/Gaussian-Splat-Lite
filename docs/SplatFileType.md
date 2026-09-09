# SplatFileType

[Back to documentation](../README.md#documentation)

Supported file formats:

```ts
enum SplatFileType {
  PLY = "ply",
  SPZ = "spz",
  SOG = "sog",
  RAD = "rad",
}
```

Usually inferred from a `.ply`, `.spz`, `.sog`, `.rad`, or SOG `meta.json` URL or `fileName`. Otherwise, set it explicitly:

```js
import { SplatFileType, SplatMesh } from "gaussian-splat-lite";

const splat = new SplatMesh({
  url: "/download/model",
  fileType: SplatFileType.SPZ,
});
```

`SplatMesh` and `Splats` accept this option for URL, file, and byte input. `SplatLoader.load()` and `loadAsync()` infer the format from the URL or file contents.
