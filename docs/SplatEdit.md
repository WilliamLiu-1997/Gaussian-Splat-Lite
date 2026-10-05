# SplatEdit and SplatEditSdf

[Back to documentation](../README.md#documentation)

Recolor, fade, or hide the part of a model that lies inside a shape, such as a sphere or a box. Splats are not moved or deleted, so an edit can be changed or removed at any time. The shapes are signed distance fields (SDFs), which is where the class names come from.

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

## SplatEdit options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Generated | Object name |
| `rgbaBlendMode` | `SplatEditRgbaBlendMode` | `MULTIPLY_RGBA` | How the shapes' color and opacity combine with the model's; see [blend modes](#blend-modes) |
| `softEdge` | `number` | `0` | Soften the edge of the edited region; `0` gives a hard edge |
| `sdfSmooth` | `number` | `0` | Blend neighboring shapes into each other smoothly |
| `invert` | `boolean` | `false` | Affect the outside of the shapes instead of the inside |
| `sdfs` | `SplatEditSdf[]` | `null` | Explicit list of shapes, instead of using child objects |

Shapes are normally children of the edit: use `edit.add(sdf)` and `edit.remove(sdf)`. If you set an explicit `sdfs` list, it is used instead of the children; manage it with `edit.addSdf(sdf)`, which skips duplicates, and `edit.removeSdf(sdf)`.

Edits apply in the order they were created. Change `edit.ordering` to reorder them.

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
