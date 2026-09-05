# SDF color and opacity editing

[Back to documentation](../README.md#documentation)

SDF edits change color and opacity within a region, preserving centers and sort order. Attach an edit to a `SplatMesh` to affect only that mesh:

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
| `rgbaBlendMode` | `SplatEditRgbaBlendMode` | `MULTIPLY_RGBA` | Multiplication, replacement, or addition on assigned RGBA channels |
| `sdfSmooth` | `number` | `0` | Smoothing amount when combining SDF shapes |
| `softEdge` | `number` | `0` | Region-edge feathering distance |
| `invert` | `boolean` | `false` | Inverts the entire edit region |
| `sdfs` | `SplatEditSdf[]` | `null` | Explicit shape list; SDFs can instead be child objects |

## SplatEdit methods

| API | Description |
| --- | --- |
| `addSdf(sdf)` | Adds an SDF to the explicit `sdfs` list without adding the same object twice |
| `removeSdf(sdf)` | Removes an SDF from the explicit `sdfs` list |

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
| `invert` | `boolean` | `false` | Inverts the inside and outside of the shape |
| `opacity` | `number` | Unassigned | Alpha value used by the edit; an unassigned alpha is preserved |
| `color` | `THREE.Color \| { r?: number; g?: number; b?: number }` | Unassigned | RGB values used by the edit; each unassigned channel is preserved |
| `radius` | `number` | `0` | Radius used by sphere, cylinder, capsule, and related shapes |

Shapes (`SplatEditSdfType`): `ALL`, `PLANE`, `SPHERE`, `BOX`, `ELLIPSOID`, `CYLINDER`, `CAPSULE`, `INFINITE_CONE`.

An SDF is a `THREE.Object3D`; its transform defines the region. Edits run in creation order unless changed with `edit.ordering`.
