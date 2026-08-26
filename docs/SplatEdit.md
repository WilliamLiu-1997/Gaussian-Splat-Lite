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
  rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY_RGBA,
  softEdge: 0.1,
  sdfSmooth: 0,
});

const sphere = new SplatEditSdf({
  type: SplatEditSdfType.SPHERE,
  color: new THREE.Color(1, 0.5, 0.5), // Assigns R, G, and B.
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

`addSdf()` and `removeSdf()` manage the explicit list. When `sdfs` is not `null`, the renderer uses that list instead of traversing the `SplatEdit` child hierarchy. Use `edit.add(sdf)` and `edit.remove(sdf)` when the SDFs should instead be regular `THREE.Object3D` children.

## RGBA blend modes

| Mode | Description |
| --- | --- |
| `MULTIPLY_RGBA` | Multiplies each assigned channel by the corresponding SDF value |
| `SET_RGBA` | Replaces each assigned channel with the corresponding SDF value |
| `ADD_RGBA` | Adds the corresponding SDF value to each assigned channel |

All three modes preserve channels that the SDF does not assign. For example,
this edit replaces only R and G; the existing B and alpha values remain unchanged:

```ts
const partialColor = new SplatEditSdf({
  color: { r: 1, g: 0.5 },
});

const edit = new SplatEdit({
  rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGBA,
  sdfs: [partialColor],
});
```

A `THREE.Color` assigns all three RGB channels. Omit `color` to preserve all RGB
channels, and omit `opacity` to preserve alpha. Assign `undefined` to an existing
channel later if it should become unassigned.

## SplatEditSdf options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `SplatEditSdfType` | `SPHERE` | SDF shape |
| `invert` | `boolean` | `false` | Inverts the inside and outside of the shape |
| `opacity` | `number` | Unassigned | Alpha value used by the edit; an unassigned alpha is preserved |
| `color` | `THREE.Color \| { r?: number; g?: number; b?: number }` | Unassigned | RGB values used by the edit; each unassigned channel is preserved |
| `radius` | `number` | `0` | Radius used by sphere, cylinder, capsule, and related shapes |

An SDF extends `THREE.Object3D`; its position, rotation, and scale define the edit region. Edits execute in creation order by default, and the order can be changed through `edit.ordering`.
