# SDF color and opacity editing

[Back to documentation](../README.md#documentation)

SDF edits change color and opacity within a shape without moving or deleting Splats. Attach an edit to a `SplatMesh` to affect only that mesh:

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

To affect all editable meshes, attach it to the scene:

```js
scene.add(edit);
```

## SplatEdit options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Generated | Object name |
| `rgbaBlendMode` | `SplatEditRgbaBlendMode` | `MULTIPLY_RGBA` | Multiply, replace, or add to the assigned color and opacity channels |
| `sdfSmooth` | `number` | `0` | Soften the join between shapes |
| `softEdge` | `number` | `0` | Soften the region boundary |
| `invert` | `boolean` | `false` | Affect the outside instead of the inside |
| `sdfs` | `SplatEditSdf[]` | `null` | Explicit shape list; SDFs can instead be child objects |

## SplatEdit methods

| API | Description |
| --- | --- |
| `addSdf(sdf)` | Add a shape to the explicit `sdfs` list without duplicates |
| `removeSdf(sdf)` | Remove a shape from the explicit `sdfs` list |

An explicit `sdfs` list takes precedence over child objects. For child shapes, use `edit.add(sdf)` and `edit.remove(sdf)`.

## RGBA blend modes

| Mode | Description |
| --- | --- |
| `MULTIPLY_RGBA` | Multiplies each assigned channel by the corresponding SDF value |
| `SET_RGBA` | Replaces each assigned channel with the corresponding SDF value |
| `ADD_RGBA` | Adds the corresponding SDF value to each assigned channel |

Unassigned channels stay unchanged. For example, `color: { r: 1, g: 0.5 }` with `SET_RGBA` replaces only R and G. A `THREE.Color` assigns all RGB channels; `opacity` assigns alpha. Set a channel to `undefined` to unassign it.

## SplatEditSdf options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `SplatEditSdfType` | `SPHERE` | SDF shape |
| `invert` | `boolean` | `false` | Affect the outside instead of the inside |
| `opacity` | `number` | Unassigned | Opacity applied inside the shape; leave unassigned to preserve it |
| `color` | `THREE.Color \| { r?: number; g?: number; b?: number }` | Unassigned | Color applied inside the shape; unassigned channels stay unchanged |
| `radius` | `number` | `0` | Radius used by sphere, cylinder, capsule, and related shapes |

Shapes (`SplatEditSdfType`): `ALL`, `PLANE`, `SPHERE`, `BOX`, `ELLIPSOID`, `CYLINDER`, `CAPSULE`, `INFINITE_CONE`.

Move, rotate, and scale shapes with normal Three.js transforms. Edits apply in creation order; use `edit.ordering` to change it.
