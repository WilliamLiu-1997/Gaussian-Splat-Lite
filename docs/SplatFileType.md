# SplatFileType

[Back to documentation](../README.md#documentation)

The model formats you can load:

| Name | Value | Files |
| --- | --- | --- |
| `SplatFileType.PLY` | `"ply"` | `.ply` |
| `SplatFileType.SPZ` | `"spz"` | `.spz` |
| `SplatFileType.SOG` | `"sog"` | `.sog`, or a SOG `meta.json` with its images |
| `SplatFileType.RAD` | `"rad"` | `.rad` |

PLY, SPZ, and SOG v3 support view-dependent color up to SH4 on WebGL, WebGPU, and the WebGL2 fallback, including SOG and LCC2 streaming. RAD and SOG v1/v2 support up to SH3. Models render all their available coefficients by default; set the [`maxSh` constructor option](SplatMesh.md#options) to limit the degree.

Standard PLY accepts the usual `opacity` logit or `opacity_linear`, which takes precedence when present and may exceed 1. Extra scalar PLY properties are ignored. Compressed PLY retains its 0–1 opacity range.

The format is normally detected from the URL or `fileName`, so you rarely need this. Set it when the name does not show the format:

```js
import { SplatFileType, SplatMesh } from "gaussian-splat-lite";

const splat = new SplatMesh({
  url: "/download/model",
  fileType: SplatFileType.SPZ,
});
```

`SplatMesh` and `Splats` accept `fileType` for URLs, files, and bytes. `SplatLoader.load()` and `loadAsync()` always detect the format themselves.

Large scenes with levels of detail load through their own classes: [RadStreamScheduler](RadStreamScheduler.md) for RAD, [SogStreamScheduler](SogStreamScheduler.md) for a SOG `lod-meta.json`, and [Lcc2StreamScheduler](Lcc2StreamScheduler.md) for a `.lcc2` index with SOG, SPZ, or PLY companion files. LCC2 uses its scheduler directly; there is no `SplatFileType.LCC2` value.
