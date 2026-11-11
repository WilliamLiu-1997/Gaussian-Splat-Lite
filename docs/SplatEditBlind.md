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

Omit `min` or `max` for a one-sided range, or both to select every value of the field. Use `value` for category labels and a range for floating-point fields. For example, to hide one label, use `new SplatEditBlind({ field: "segment", value: 3, opacity: 0 })` in an edit with `SET_RGBA` and `softEdge: 0`.

A `min` above `max` selects nothing. Invalid options throw from the constructor; if a later change makes them invalid, the selection has no effect until they are valid again.

Only assigned color and opacity channels change. The parent edit controls `MULTIPLY_RGBA`, `SET_RGBA`, or `ADD_RGBA`, just as for SDF shapes. Edits change only how the model is drawn: [picking](SplatMesh.md#raycasting) and `getSplat()` still see the original values, including Gaussians an edit hides.

## Edges, smoothing, and inversion

- `softEdge` softens the range boundaries; `0` gives a hard edge. Its width uses the field's value units.
- `sdfSmooth` smooths transitions between selections and has no effect with only one selection. Overlapping selections blend their color and opacity even when it is `0`.
- `selection.invert` reverses that selection; `edit.invert` reverses the combined selection.
- Object position, rotation, and scale do not affect Blind values or their ranges.

Selections can be children of the edit or entries in its explicit `sdfs` list. Ordering, visibility, and attachment follow the same rules as `SplatEditSdf`.

## Supported fields

SOG v3 files, bundled or split, load their Blind fields automatically, following the [SOG v3 proposal](https://github.com/playcanvas/splat-transform/issues/362). Supported types are `u8`, `u16`, `u24`, `u32`, `f16`, `f32`, `unorm8`, and `unorm16`. Normalized fields are selected in their declared `range`, or `[0, 1]` when omitted. NaN and infinite values are never selected. A field group with invalid metadata, such as an unsupported type, is skipped with a console warning; the model still loads.

Blind data adds memory and loading cost. If you do not need it, set `blindData: false` on [SplatMesh](SplatMesh.md#options), [Splats](Splats.md#options), [SplatLoader](SplatLoader.md), [SogStreamScheduler](SogStreamScheduler.md#options), or [Lcc2StreamScheduler](Lcc2StreamScheduler.md#options) to skip it; Blind selections then have no effect. If you load streaming chunks with your own `loadChunk` callback, skip Blind data in that loader too.

After loading, `mesh.splats.blindFields` lists the field definitions grouped as in SOG metadata. Treat these definitions as read-only.
