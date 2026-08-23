# SplatFileType

[Back to the API overview](../README.md#core-concepts-and-public-api)

`SplatFileType` identifies the two file formats decoded by Gaussian-Splat-Lite:

```ts
enum SplatFileType {
  PLY = "ply",
  SPZ = "spz",
}
```

The loader normally infers the type from a URL or `fileName` ending in `.ply` or `.spz`. Specify `fileType` when the input name has no recognizable extension or when loading unnamed in-memory data.

```js
import { SplatFileType, SplatMesh } from "gaussian-splat-lite";

const fromUrl = new SplatMesh({
  url: "/download/model",
  fileType: SplatFileType.SPZ,
});

const fromMemory = new SplatMesh({
  fileBytes: bytes,
  fileType: SplatFileType.PLY,
});
```

The same `fileType` option is accepted by `SplatMesh`, `Splats`, and the low-level `SplatLoader.loadInternal()` APIs.
