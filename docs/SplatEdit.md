# SDF color and opacity editing

[Back to the API overview](../README.md#core-concepts-and-public-api)

SDF edits affect RGBA only. They do not move Splat centers or invalidate an existing depth order. Available shapes are:

```ts
SplatEditSdfType.ALL
SplatEditSdfType.PLANE
SplatEditSdfType.SPHERE
SplatEditSdfType.BOX
SplatEditSdfType.ELLIPSOID
SplatEditSdfType.CYLINDER
SplatEditSdfType.CAPSULE
SplatEditSdfType.INFINITE_CONE
```

The following edit affects only `splat`:

```js
import * as THREE from "three";
import {
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
} from "gaussian-splat-lite";

const edit = new SplatEdit({
  name: "Warm sphere",
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
  softEdge: 0.1,
  sdfSmooth: 0,
});

const sphere = new SplatEditSdf({
  type: SplatEditSdfType.SPHERE,
  color: new THREE.Color(1, 0.5, 0.5),
  opacity: 0.4,
  radius: 1,
});

sphere.position.set(0, 0, 0);
edit.add(sphere);
splat.add(edit);
```

Adding a `SplatEdit` directly to the scene, rather than below a particular `SplatMesh`, makes it a global edit for every editable Splat mesh:

```js
scene.add(edit);
```

## SplatEdit options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Generated | Object name |
| `rgbaBlendMode` | `SplatEditRgbaBlendMode` | `MULTIPLY` | Component-wise multiplication, RGB replacement, or RGBA addition |
| `sdfSmooth` | `number` | `0` | Smoothing amount when combining SDF shapes |
| `softEdge` | `number` | `0` | Region-edge feathering distance |
| `invert` | `boolean` | `false` | Inverts the entire edit region |
| `sdfs` | `SplatEditSdf[]` | `null` | Explicit shape list; SDFs can instead be child objects |

## SplatEdit methods

| API | Description |
| --- | --- |
| `addSdf(sdf)` | Adds an SDF to the explicit `sdfs` list without adding the same object twice |
| `removeSdf(sdf)` | Removes an SDF from the explicit `sdfs` list |

`addSdf()` and `removeSdf()` manage the explicit list. When `sdfs` is not `null`, the renderer uses that list instead of traversing the `SplatEdit` child hierarchy. Use `edit.add(sdf)` and `edit.remove(sdf)` when the SDFs should instead be regular `THREE.Object3D` children.

## RGBA blend modes

| Mode | Description |
| --- | --- |
| `MULTIPLY` | Multiplies the existing RGBA component-wise by the SDF RGBA |
| `SET_RGB` | Replaces RGB with the SDF color and multiplies the existing alpha by the SDF opacity |
| `ADD_RGBA` | Adds the SDF RGBA to the existing RGBA |

## SplatEditSdf options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `SplatEditSdfType` | `SPHERE` | SDF shape |
| `invert` | `boolean` | `false` | Inverts the inside and outside of the shape |
| `opacity` | `number` | `1` | Alpha value used by the edit |
| `color` | `THREE.Color` | White | RGB value used by the edit |
| `radius` | `number` | `0` | Radius used by sphere, cylinder, capsule, and related shapes |

An SDF extends `THREE.Object3D`; its position, rotation, and scale define the edit region. Edits execute in creation order by default, and the order can be changed through `edit.ordering`.
