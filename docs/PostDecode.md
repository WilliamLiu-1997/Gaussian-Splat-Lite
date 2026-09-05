# postDecode `Experimental`

[Back to documentation](../README.md#documentation)

Transforms each Splat while decoding PLY/SPZ files. Experimental: developed for [3D-Tiles-RendererJS-3DGS-Plugin](https://github.com/WilliamLiu-1997/3D-Tiles-RendererJS-3DGS-Plugin), and may change or be removed.

`define()` runs its callback immediately to build an expression program. The worker executes that program; the library handles packing and sorting centers.

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

Also accepted by `Splats`. The transform preserves Splat count and order.

## Logical input

| Field | Type | Description |
| --- | --- | --- |
| `splat.position` | `vec3` | xyz center |
| `splat.scale` | `vec3` | Linear scale |
| `splat.quaternion` | `quaternion` | xyzw rotation |
| `splat.opacity` | `float` | Semantic opacity in the `[0, 1000]` range |
| `splat.alpha` | `float` | Standard alpha in the `[0, 1]` range |
| `splat.color` | `vec3` | RGB color |
| `splat.sh.coefficient(index)` | `vec3` | One of the 15 degree-1-through-3 RGB coefficients |

`splat.sh.map((coefficient, { degree }) => ...)` builds expressions for all 15 coefficients; only those present in the source are updated.

## Patch output

Return any subset of `position`, `scale`, `quaternion`, `opacity`, `alpha`, `color`, or `sh`. Omitted fields stay unchanged. If `when` is false, the entire Splat stays byte-for-byte unchanged.

- `opacity` is clamped to `[0, 1000]`.
- `alpha` is clamped to `[0, 1]`, preserving other opacity state. Output either `opacity` or `alpha`, never both.
- Quaternions are normalized. Invalid or zero-length results preserve the original.
- Position and scale updates keep sorting centers synchronized.
- SH uses the `Splats` codec: NaN channels become zero without affecting the shared exponent; nonnegative magnitudes round to nearest, with ties up. Expressions use float32 precision.

`when` short-circuits nested `and`, `or`, and `not` expressions. Put cheap, selective predicates first. Group explicitly: `op.or(A, op.and(B, C))` means `A || (B && C)`. Programs are limited to 4096 instructions.

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
- Attribute bytes travel with the program to the worker. If an attribute is shorter than the file, only the common prefix is processed.

## Expression operations

Use `op` for runtime expressions; JavaScript `if` cannot inspect a Splat value.

- arithmetic: `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `clamp`, `mix`, `neg`, `abs`, `sqrt`, `log`, `exp`, `floor`, `ceil`, `round`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, and `atan2`;
- predicates: `isFinite`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `and`, `or`, `not`, and `select`;
- vectors: `vec2`, `vec3`, `vec4`, `component`, `length`, `normalize`, `dot`, `cross`, and `maxComponentIndex`;
- rotations: `quaternion`, `quatMul`, and `rotateVector`;

Scalar arithmetic broadcasts over vector operands. Values from different `postDecode` programs cannot be combined.
