# SplatEdit and SplatEditSdf

[Back to documentation](../README.md#documentation)

Resize, recolor, fade, or hide individual Gaussians inside a shape such as a sphere or a box. Splats are not moved or deleted, so an edit can be changed or removed at any time. The shapes are signed distance fields (SDFs), which is where the class names come from.

A `SplatEdit` holds the settings, and one or more `SplatEditSdf` shapes say where it applies. Attach the edit to a `SplatMesh` to affect only that mesh:

```js
import * as THREE from "three";
import {
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
} from "gaussian-splat-lite";

const edit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY_RGBA,
  softEdge: 0.1,
});

const sphere = new SplatEditSdf({
  type: SplatEditSdfType.SPHERE,
  color: new THREE.Color(1, 0.5, 0.5),
  opacity: 0.4,
  radius: 1,
});

edit.add(sphere);
splat.add(edit);
```

To affect every editable mesh, attach it to the scene instead:

```js
scene.add(edit);
```

A mesh created with `editable: false` ignores edits. Edits also work on [streamed scenes](RadStreamScheduler.md).

Use a separate [SplatEditBlind](SplatEditBlind.md) group with `SplatEditBlindField` selections to edit by SOG v3 field values or ranges. `SplatEdit` accepts only `SplatEditSdf` selections; the two selection types cannot share an edit group.

## SplatEdit options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Generated | Object name |
| `rgbaBlendMode` | `SplatEditRgbaBlendMode` | `MULTIPLY_RGBA` | How the shapes' color and opacity combine with the model's; see [blend modes](#blend-modes) |
| `softEdge` | `number` | `0` | Soften the edge of the edited region; `0` gives a hard edge |
| `sdfSmooth` | `number` | `0` | Smooth transitions between shapes; needs at least two shapes. `0` disables smoothing |
| `invert` | `boolean` | `false` | Affect the outside of the shapes instead of the inside |
| `sdfs` | `SplatEditSdf[]` | `null` | Explicit list of shapes, instead of using child objects |

Shapes are normally children of the edit: use `edit.add(sdf)` and `edit.remove(sdf)`. If you set an explicit `sdfs` list, it is used instead of the children; manage it with `edit.addSdf(sdf)`, which skips duplicates, and `edit.removeSdf(sdf)`.

SDF and Blind edit groups apply in the order they were created. Change `edit.ordering` to reorder them. Edit groups cannot be nested.

## Resizing Splats

```js
const resize = new SplatEdit({ softEdge: 0.4 });
resize.add(new SplatEditSdf({ type: SplatEditSdfType.SPHERE, radius: 3, uniformScale: 2 }));
splat.add(resize);
```

Attach the edit to a mesh for a local effect or to the scene for a global effect on editable meshes. Moving its shapes updates the selection. At full strength the example doubles all three axes. At the boundary, a weight of 0.5 gives a multiplier of 1.5. Overlapping shapes in one edit blend their multipliers by selection weight. Separate edits multiply their size effects. A multiplier of zero hides a fully selected Splat.

Centers stay fixed, so size edits reuse the WebGL depth order. Raycasting and source bounds continue to use the original Splat sizes.

## Blend modes

| Mode | Description |
| --- | --- |
| `MULTIPLY_RGBA` | Multiply the model's color and opacity by the shape's values |
| `SET_RGBA` | Replace the model's color and opacity with the shape's values |
| `ADD_RGBA` | Add the shape's values to the model's color and opacity |

Only the channels a shape assigns are affected. A `THREE.Color` assigns red, green, and blue; `opacity` assigns alpha. For example, `color: { r: 1, g: 0.5 }` with `SET_RGBA` replaces only red and green. Set a channel to `undefined` to stop assigning it.

## SplatEditSdf options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `SplatEditSdfType` | `SPHERE` | Shape |
| `color` | `THREE.Color \| { r?: number; g?: number; b?: number }` | Unassigned | Color applied inside the shape |
| `opacity` | `number` | Unassigned | Opacity applied inside the shape |
| `uniformScale` | `number` | `1` | Multiplies the three axes of each selected Splat about its own center. Accepts finite, nonnegative float32 values. |
| `radius` | `number` | `0` | Radius of a sphere, cylinder, capsule, and similar shapes |
| `invert` | `boolean` | `false` | Affect the outside of this shape instead of the inside |

Shapes (`SplatEditSdfType`): `ALL`, `PLANE`, `SPHERE`, `BOX`, `ELLIPSOID`, `CYLINDER`, `CAPSULE`, `INFINITE_CONE`.

## Placing and sizing shapes

Move, rotate, and scale shapes like any Three.js object, including through their parents.

- `BOX` and `ELLIPSOID` take their half-size from `scale`.
- `CAPSULE` takes its length from `scale.y`.
- For those three shapes, scaling does not change `radius`. Other shapes, `SPHERE` included, scale as a whole.
- A shape scaled to zero on any axis has no effect, even when inverted.
- With uneven scaling, soft edges are approximate.
