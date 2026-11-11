# SplatEditBlind and SplatEditBlindField

[Back to documentation](../README.md#documentation)

Recolor, fade, or hide Gaussians selected by SOG v3 Blind fields. A `SplatEditBlind` holds the edit settings, and one or more `SplatEditBlindField` children select field values or ranges.

```js
import {
  SplatEditBlind,
  SplatEditBlindField,
  SplatEditRgbaBlendMode,
} from "gaussian-splat-lite";

const edit = new SplatEditBlind({
  rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGBA,
  invert: false,
  softEdge: 0.1,
});

const selection = new SplatEditBlindField({
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

## SplatEditBlind options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Generated | Object name |
| `rgbaBlendMode` | `SplatEditRgbaBlendMode` | `MULTIPLY_RGBA` | [Blend mode](SplatEdit.md#blend-modes) for color and opacity |
| `softEdge` | `number` | `0` | Soften range boundaries in field-value units; `0` gives a hard edge |
| `invert` | `boolean` | `false` | Reverse the combined selection |
| `fields` | `SplatEditBlindField[]` | `null` | Explicit list of selections, instead of using child objects |

Use `edit.add(selection)` and `edit.remove(selection)` for children. If you set an explicit `fields` list, it is used instead; manage it with `edit.addField(selection)`, which skips duplicates, and `edit.removeField(selection)`.

SDF and Blind edit groups share the same creation order. Change `edit.ordering` to reorder them. Edit groups cannot be nested. Spatial `SplatEditSdf` shapes belong in a separate [SplatEdit](SplatEdit.md) group; the two selection types cannot share an edit group. Blind groups have no `sdfSmooth` option.

## SplatEditBlindField options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `field` | `string` | Required | Exact field name from SOG metadata |
| `min` | `number` | Unbounded | Inclusive lower bound; `-Infinity` also means unbounded |
| `max` | `number` | Unbounded | Inclusive upper bound; `Infinity` also means unbounded |
| `value` | `number` | Unassigned | Exact finite match; cannot be combined with `min` or `max` |
| `invert` | `boolean` | `false` | Invert this selection |
| `color` | `THREE.Color \| { r?: number; g?: number; b?: number }` | Unassigned | Color to apply |
| `opacity` | `number` | Unassigned | Opacity to apply |

Omit `min` or `max` for a one-sided range, or both to select every value of the field. Use `value` for category labels and a range for floating-point fields. For example, to hide one label, add `new SplatEditBlindField({ field: "segment", value: 3, opacity: 0 })` to a Blind edit with `SET_RGBA` and `softEdge: 0`.

A `min` above `max` selects nothing. Invalid options throw from the constructor; if a later change makes them invalid, the selection has no effect until they are valid again.

Only assigned color and opacity channels change. The parent edit controls `MULTIPLY_RGBA`, `SET_RGBA`, or `ADD_RGBA`, just as for SDF shapes. Edits change only how the model is drawn: [picking](SplatMesh.md#raycasting) and `getSplat()` still see the original values, including Gaussians an edit hides.

## Edges and inversion

- `softEdge` softens the range boundaries; `0` gives a hard edge. Its width uses the field's value units.
- A group selects Gaussians matching any of its field selections. Overlapping selections within the group blend their color and opacity; separate groups apply in order.
- `selection.invert` reverses that selection; `edit.invert` reverses the combined selection.
- Object position, rotation, and scale do not affect Blind values or their ranges.

## Supported fields

SOG v3 files, bundled or split, load their Blind fields automatically, following the [SOG v3 proposal](https://github.com/playcanvas/splat-transform/issues/362). Supported types are `u8`, `u16`, `u24`, `u32`, `f16`, `f32`, `unorm8`, and `unorm16`. Normalized fields are selected in their declared `range`, or `[0, 1]` when omitted. NaN and infinite values are never selected. A field group with invalid metadata, such as an unsupported type, is skipped with a console warning; the model still loads.

Blind data adds memory and loading cost. If you do not need it, set `blindData: false` on [SplatMesh](SplatMesh.md#options), [Splats](Splats.md#options), [SplatLoader](SplatLoader.md), [SogStreamScheduler](SogStreamScheduler.md#options), or [Lcc2StreamScheduler](Lcc2StreamScheduler.md#options) to skip it; Blind selections then have no effect. If you load streaming chunks with your own `loadChunk` callback, skip Blind data in that loader too.

After loading, `mesh.splats.blindFields` lists the field definitions grouped as in SOG metadata. Treat these definitions as read-only.
