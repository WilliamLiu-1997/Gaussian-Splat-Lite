# SplatEditBlind

[Back to documentation](../README.md#documentation)

Recolor, fade, or hide Gaussians selected by a SOG v3 Blind field. Add a `SplatEditBlind` to [SplatEdit](SplatEdit.md) in place of a spatial `SplatEditSdf` shape.

```js
import {
  SplatEdit,
  SplatEditBlind,
  SplatEditRgbaBlendMode,
} from "gaussian-splat-lite";

const edit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGBA,
  invert: false,
  softEdge: 0.1,
  sdfSmooth: 0,
});

const selection = new SplatEditBlind({
  field: "confidence",
  min: 0.5,
  max: 1,
  color: { r: 1, g: 0.2, b: 0.2 },
  opacity: 0.4,
});

edit.add(selection);
mesh.add(edit);

// Changes take effect on the next render update.
selection.min = 0.7;
selection.invert = true;

// Remove the effect.
mesh.remove(edit);
```

Attach the edit to a mesh to affect that mesh, or use `scene.add(edit)` for all editable meshes, including current and future SOG/LCC2 streaming chunks. A mesh without the named field is unaffected, even when inverted. `editable: false` disables edits.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `field` | `string` | Required | Exact field name from SOG metadata |
| `min` | `number` | Unbounded | Inclusive lower bound; `-Infinity` also means unbounded |
| `max` | `number` | Unbounded | Inclusive upper bound; `Infinity` also means unbounded |
| `value` | `number` | Unassigned | Exact finite match; cannot be combined with `min` or `max` |
| `invert` | `boolean` | `false` | Invert this selection |
| `color` | `THREE.Color \| { r?: number; g?: number; b?: number }` | Unassigned | Color to apply |
| `opacity` | `number` | Unassigned | Opacity to apply |

Omit `min` or `max` for a one-sided range. Omit both to select all finite values of the field. A `min` above `max` selects nothing, including with soft edges or smoothing; inverting that empty selection selects everything on meshes with the field. The constructor throws for a missing `field`, a non-finite `value`, or a `value` combined with `min` or `max`; if later changes make the options invalid, the selection has no effect until they are valid again. For a category label, use `new SplatEditBlind({ field: "segment", value: 3, opacity: 0 })` with `SET_RGBA` and `softEdge: 0` to hide that label. Floating-point fields are best selected with a range.

Only assigned color and opacity channels change. The parent edit controls `MULTIPLY_RGBA`, `SET_RGBA`, or `ADD_RGBA`, just as for SDF shapes. Edits change rendered appearance without modifying source Gaussian data; CPU raycasting still reads the stored records.

## Edges, smoothing, and inversion

- `softEdge: 0` selects the inclusive range exactly. Positive `softEdge` gives a linear transition centered on each bound, measured in the field's decoded value units. For example, `min: 0.5` and `softEdge: 0.1` transition from no effect at `0.45` to full effect at `0.55`, away from the upper bound.
- `sdfSmooth` smoothly combines multiple selections using the existing SDF union and channel blending. It has no effect with only one selection. Different fields, or Blind and spatial SDF selections, should have comparable distance scales for meaningful smoothing.
- `selection.invert` reverses that selection; `edit.invert` reverses the combined selection. At a hard edge, inversion excludes the original range endpoints. With a soft edge, both sides meet at half strength on the boundary.
- Object position, rotation, and scale do not affect Blind values or their ranges.

Selections can be children of the edit or entries in its explicit `sdfs` list. Ordering, visibility, and attachment follow the same rules as `SplatEditSdf`.

## Supported fields

SOG v3 archives and split `meta.json` files load Blind fields automatically, following the [SOG v3 proposal](https://github.com/playcanvas/splat-transform/issues/362). Supported types are `u8`, `u16`, `u24`, `u32`, `f16`, `f32`, `unorm8`, and `unorm16`. Integer selection preserves adjacent values throughout the `u32` range. Normalized fields use their declared `range`, or `[0, 1]` when omitted. Non-finite float values fall outside any range. A Blind texture with invalid metadata, such as an unsupported type, is skipped with a console warning; the model still loads.

Each Blind texture keeps 4 bytes per Gaussian in memory, plus allocation padding, and as much again on the GPU once a Blind selection uses it; streamed chunks always upload it. If you do not need it, set `blindData: false` on [SplatMesh](SplatMesh.md#options), [Splats](Splats.md#options), [SplatLoader](SplatLoader.md), [SogStreamScheduler](SogStreamScheduler.md#options), or [Lcc2StreamScheduler](Lcc2StreamScheduler.md#options) to skip its decoding and storage. Blind selections then have no effect.

The built-in loader also skips Blind image downloads for split files and archives served with usable HTTP Range responses. If the server sends the whole archive, its Blind bytes are still downloaded. With a custom streaming `loadChunk` callback, configure that loader separately to skip Blind downloads and decoding; the scheduler discards returned Blind data when `blindData: false`.

After loading, `mesh.splats.blindFields` lists the field definitions grouped as in SOG metadata. Treat these definitions as read-only. Fields remain associated with their Gaussians through reordering and streaming.
