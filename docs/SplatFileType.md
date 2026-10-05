# SplatFileType

[Back to documentation](../README.md#documentation)

The model formats you can load:

| Name | Value | Files |
| --- | --- | --- |
| `SplatFileType.PLY` | `"ply"` | `.ply` |
| `SplatFileType.SPZ` | `"spz"` | `.spz` |
| `SplatFileType.SOG` | `"sog"` | `.sog`, or a SOG `meta.json` with its images |
| `SplatFileType.RAD` | `"rad"` | `.rad` |

The format is normally detected from the URL or `fileName`, so you rarely need this. Set it when the name does not show the format:

```js
import { SplatFileType, SplatMesh } from "gaussian-splat-lite";

const splat = new SplatMesh({
  url: "/download/model",
  fileType: SplatFileType.SPZ,
});
```

`SplatMesh` and `Splats` accept `fileType` for URLs, files, and bytes. `SplatLoader.load()` and `loadAsync()` always detect the format themselves.

Large scenes with levels of detail load through their own classes: [SogStreamScheduler](SogStreamScheduler.md) for a SOG `lod-meta.json`, and [RadStreamScheduler](RadStreamScheduler.md) for RAD.
