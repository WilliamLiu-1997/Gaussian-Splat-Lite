# postDecode

[Back to documentation](../README.md#documentation)

Changes each Splat while loading PLY/SPZ/SOG/RAD files. Use `define()` to describe the changes, then pass the result as `postDecode`.

`define()` runs its callback immediately to build an expression program; the decode worker executes that program for each Splat.

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

Also accepted by `Splats`. The example shifts the model and gives it a warmer tint. All `postDecode` transforms preserve Splat count and order.

## Logical input

| Field | Type | Description |
| --- | --- | --- |
| `splat.position` | `vec3` | xyz center |
| `splat.scale` | `vec3` | Linear scale along each axis |
| `splat.quaternion` | `quaternion` | xyzw rotation |
| `splat.opacity` | `float` | Model opacity, including values above 1 |
| `splat.alpha` | `float` | Alpha from 0 (transparent) to 1 (opaque) |
| `splat.color` | `vec3` | RGB color |
| `splat.sh.coefficient(index)` | `vec3` | One of the 15 degree-1-through-3 RGB coefficients |

`splat.sh.map((coefficient, { degree }) => ...)` builds expressions for all 15 coefficients; only those present in the source are updated.

## Patch output

Return any subset of `position`, `scale`, `quaternion`, `opacity`, `alpha`, `color`, or `sh`. Omitted fields stay unchanged. Use `when` to apply changes only to matching Splats; when false, the entire Splat stays byte-for-byte unchanged.

- Negative `opacity` values become zero. Values above 1 use an extended kernel shape and saturate at the codec's maximum shape.
- `alpha` is clamped to `[0, 1]`, preserving other opacity state. Output either `opacity` or `alpha`, never both.
- Quaternions are normalized. Invalid or zero-length results preserve the original.
- Position and scale updates keep sorting centers synchronized.

`when` short-circuits nested `and`, `or`, and `not` expressions, so put cheap, selective conditions first. For example, `op.or(A, op.and(B, C))` means `A || (B && C)`.

Expressions use float32 precision. Programs are limited to 4096 instructions, and compiled conditions to 4096 flow nodes; exceeding either limit throws. Output uses the `Splats` packed codecs, so stored values may be quantized. SH NaN channels become zero without affecting other channels' shared exponent.

## External attributes

Inside `define(({ splat, op, attribute }) => ...)`, bind per-Splat data with `attribute()`:

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
- `components` accepts 1–4. Formats: `f32`, `f16`, `u8`, `unorm8`, `i8`, `snorm8`, `u16`, `unorm16`, `i16`, `snorm16`, `u32`, `i32`.
- Match attributes to Splats in file order. If an attribute array is shorter than the model, only the matching prefix is changed.

## Expression operations

Use `op` to calculate per-Splat values; JavaScript `if` does not evaluate individual Splats.

- arithmetic: `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `clamp`, `mix`, `neg`, `abs`, `sqrt`, `log`, `exp`, `floor`, `ceil`, `round`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, and `atan2`;
- predicates: `isFinite`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `and`, `or`, `not`, and `select`;
- vectors: `vec2`, `vec3`, `vec4`, `component`, `length`, `normalize`, `dot`, `cross`, and `maxComponentIndex`;
- rotations: `quaternion`, `quatMul`, and `rotateVector`;

A number can be combined with a vector, for example `op.mul(splat.scale, 2)`. Values from different `postDecode` programs cannot be combined.

To change a model after loading, use [Splats](Splats.md) or [region edits](SplatEdit.md).
