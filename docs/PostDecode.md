# postDecode

[Back to documentation](../README.md#documentation)

Changes every Splat of a model while it loads: move it, scale it, recolor it, or adjust its opacity. Describe the change once with `postDecode.define()`, then pass the result as the `postDecode` option of `SplatMesh` or `Splats`. It works for PLY, SPZ, SOG, and RAD files.

```ts
import { postDecode, SplatFileType, SplatMesh } from "gaussian-splat-lite";

const transform = postDecode.define(({ splat, op }) => ({
  position: op.add(splat.position, [1, 0, 0]),
  color: op.mul(splat.color, [1, 0.8, 0.8]),
}));

const mesh = new SplatMesh({
  fileBytes,
  fileType: SplatFileType.SPZ,
  postDecode: transform,
});
await mesh.initialized;
```

This example shifts the model and gives it a warmer tint.

Your callback runs once, right away, to record the calculation; it does not run for each Splat. That has two consequences:

- Build the calculation with the `op` functions. A JavaScript `if` or `+` cannot see individual Splats.
- Mistakes in the calculation throw immediately from `define()`, not later during loading.

A transform never adds, removes, or reorders Splats. The [reordering done by loading](Splats.md#data-rules) happens afterwards.

To change a model after it has loaded, use [SplatMesh properties](SplatMesh.md#properties) or [SDF edits](SplatEdit.md) instead.

## Splat fields

Read these from `splat`:

| Field | Type | Description |
| --- | --- | --- |
| `splat.position` | `vec3` | Center, xyz |
| `splat.scale` | `vec3` | Size along each axis |
| `splat.quaternion` | `quaternion` | Rotation, xyzw |
| `splat.opacity` | `float` | Opacity as stored in the model, which can be above 1 |
| `splat.alpha` | `float` | Opacity from 0 (transparent) to 1 (opaque) |
| `splat.color` | `vec3` | RGB color |
| `splat.sh.coefficient(index)` | `vec3` | One of the 15 view-dependent color coefficients |

`splat.sh.map((coefficient, { degree }) => ...)` builds a calculation for all 15 coefficients at once. Only the ones the model has are updated.

## Returning changes

Return any of `position`, `scale`, `quaternion`, `opacity`, `alpha`, `color`, or `sh`. Fields you leave out stay as they are.

Add `when` to change only the Splats that match a condition. Splats that do not match stay exactly as loaded:

```ts
const transform = postDecode.define(({ splat, op }) => ({
  when: op.lt(op.component(splat.position, 1), 0), // Only Splats below y = 0.
  alpha: 0,
}));
```

Rules for the values you return:

- Return `opacity` or `alpha`, never both. `alpha` is limited to 0–1. A negative `opacity` becomes 0, and values above 1 are allowed up to a fixed maximum.
- Quaternions are normalized for you. An invalid or zero-length result keeps the original rotation.
- Values are stored in a compact format, so what you read back later can differ slightly from what you calculated.

## External data

Inside `define(({ splat, op, attribute }) => ...)`, use `attribute()` to bring in your own per-Splat data, such as a weight or label for each Splat:

```ts
const weights = attribute({
  data: interleavedView,
  format: "unorm16",
  count: splatCount,
  components: 3,
  byteOffset: 4,
  byteStride: 16,
});
```

- `data` accepts any `ArrayBufferView`, including `DataView`; `byteOffset` is relative to that view.
- `components` can be 1 to 4. Formats: `f32`, `f16`, `u8`, `unorm8`, `i8`, `snorm8`, `u16`, `unorm16`, `i16`, `snorm16`, `u32`, `i32`.
- Order the data like the Splats in the original file, for RAD files too. If it is shorter than the model, only the Splats it covers are changed.
- The data is read when a load starts. Changing it afterwards affects only later loads.

## Operations

- **Arithmetic:** `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `clamp`, `mix`, `neg`, `abs`, `sqrt`, `log`, `exp`, `floor`, `ceil`, `round`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`
- **Conditions:** `isFinite`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `and`, `or`, `not`, `select`
- **Vectors:** `vec2`, `vec3`, `vec4`, `component`, `length`, `normalize`, `dot`, `cross`, `maxComponentIndex`
- **Rotations:** `quaternion`, `quatMul`, `rotateVector`

Things to know:

- A number can be combined with a vector: `op.mul(splat.scale, 2)`.
- Comparisons and vector products need matching types. `eq` and `ne` compare two values of the same type; `lt`, `lte`, `gt`, and `gte` compare numbers; `dot` takes two vectors of the same size; `cross` takes two `vec3` values.
- `op.or(A, op.and(B, C))` means `A || (B && C)`. Conditions stop as soon as the answer is known, so put cheap conditions that rule out many Splats first.
- Values from different `define()` calls cannot be combined.
- Calculations use 32-bit floats.
- Very large calculations throw: the limit is 4096 operations.
