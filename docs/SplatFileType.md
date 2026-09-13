# SplatFileType

[Back to documentation](../README.md#documentation)

Supported formats for ordinary model loading:

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

`SplatMesh` and `Splats` accept this option for URL, file, and byte input. `SplatLoader.load()` and `loadAsync()` detect the format automatically.

For a SOG `lod-meta.json` scene, use [SogStreamScheduler](SogStreamScheduler.md). For RAD scenes with levels of detail, use [RadStreamScheduler](RadStreamScheduler.md).
