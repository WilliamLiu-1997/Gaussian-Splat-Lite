# SplatFileType

[Back to documentation](../README.md#documentation)

Supported file formats:

```ts
enum SplatFileType {
  PLY = "ply",
  SPZ = "spz",
}
```

Usually inferred from a `.ply` or `.spz` URL or `fileName`. Otherwise, set it explicitly:

```js
import { SplatFileType, SplatMesh } from "gaussian-splat-lite";

const splat = new SplatMesh({
  url: "/download/model",
  fileType: SplatFileType.SPZ,
});
```

`SplatMesh`, `Splats`, and `SplatLoader.loadInternal()` accept this option for URL, byte, and stream input.
