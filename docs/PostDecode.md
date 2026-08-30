# postDecode `Experimental`

[Back to the API overview](../README.md#core-concepts-and-public-api)

`postDecode` currently exists to support post-decode processing for
[3D-Tiles-RendererJS-3DGS-Plugin](https://github.com/WilliamLiu-1997/3D-Tiles-RendererJS-3DGS-Plugin).
It may be removed if a better solution becomes available, and its API may change
in future releases.

`postDecode` describes a logical transform for one decoded Splat. The callback runs immediately and builds a serializable expression program; the callback itself is never sent to a Web Worker. Gaussian Splat Lite executes that program in the decode worker and owns all packed-array, SH-layout, sorting-center, and re-encoding details.

```ts
import { postDecode, SplatFileType, SplatMesh } from "gaussian-splat-lite";

const externalOpacity = new Float32Array([0.5, 1.5, 0.8]);
const transform = postDecode.define(({ splat, op, attribute }) => {
  const opacity = attribute({
    data: externalOpacity,
    format: "f32",
    count: externalOpacity.length,
  });

  return {
    when: op.and(op.isFinite(opacity), op.gte(opacity, 0)),
    position: op.add(splat.position, [1, 0, 0]),
    scale: op.mul(splat.scale, [2, 1, 1]),
    opacity,
    color: op.mul(splat.color, [1, 0.8, 0.8]),
    sh: splat.sh.map((coefficient, { degree }) =>
      op.mul(coefficient, 1 / degree),
    ),
  };
});

const mesh = new SplatMesh({
  fileBytes,
  fileType: SplatFileType.SPZ,
  postDecode: transform,
});
await mesh.initialized;
```

The same `postDecode` option is available on `Splats`. It applies only while decoding PLY/SPZ input and does not change the Splat count or array topology.

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

`splat.sh.map()` unrolls all 15 coefficient expressions while building the program. At runtime, the library updates only coefficients present in the decoded source.

## Patch output

Return any subset of `position`, `scale`, `quaternion`, `opacity`, `alpha`, `color`, or `sh`. Omitted fields preserve their decoded value. `when` guards the complete patch; when it evaluates to false, that Splat remains byte-for-byte unchanged.

- `opacity` is clamped to `[0, 1000]`. The library owns any nonlinear or packed representation needed to store it.
- `alpha` is clamped to `[0, 1]` and updates standard transparency independently; the library preserves any other state represented by semantic `opacity`.
- `opacity` and `alpha` cannot be output together.
- Output quaternions are normalized by the library. An invalid or zero-length result preserves the decoded quaternion.
- Position and scale changes automatically keep worker sorting centers synchronized.

Nested `op.and()`, `op.or()`, and `op.not()` expressions in `when` are compiled into one forward control flow and short-circuited per Splat inside each worker block. Each stage directly compacts its continuing Splats and queues only Splats that branch to a later stage, without rescanning the full block for every predicate. Consecutive stages with a unique predecessor reuse live values; branch merges start an independent dense subgraph because no single register layout can represent every incoming path. NOT is pushed through logical branches using De Morgan's laws, so `op.not(op.and(A, B))` short-circuits like `op.or(op.not(A), op.not(B))`. Put cheap, selective predicates first so resolved Splats skip later attribute reads and arithmetic. Expression nesting defines grouping; for `A || B && C`, use `op.or(A, op.and(B, C))`, so the AND branch is evaluated before it participates in the OR. There is no fixed limit on the number of operands beyond the existing 4096-instruction program limit.

## External attributes

`attribute()` binds per-Splat scalar or vector data without exposing the library's packed representation:

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

`data` accepts any `ArrayBufferView`, including `DataView`. `byteOffset` is relative to that view. Supported formats are `f32`, `f16`, `u8`, `unorm8`, `i8`, `snorm8`, `u16`, `unorm16`, `i16`, `snorm16`, `u32`, and `i32`; `components` may be 1 through 4. Attribute bytes are serialized with the program and transferred to the decode worker. If an attribute has fewer entries than the decoded file, the program processes only the common prefix and leaves remaining Splats unchanged.

## Expression operations

Expressions are assembled with `op`; ordinary JavaScript branching cannot inspect a runtime Splat value. Available operations include:

- arithmetic: `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `clamp`, `mix`, `neg`, `abs`, `sqrt`, `log`, `exp`, `floor`, `ceil`, `round`, `sin`, `cos`, and `acos`;
- predicates: `isFinite`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `and`, `or`, `not`, and `select`;
- vectors: `vec2`, `vec3`, `vec4`, `component`, `length`, `normalize`, `dot`, `cross`, and `maxComponentIndex`;
- rotations: `quaternion`, `quatMul`, and `rotateVector`;

Scalar arithmetic broadcasts over vector operands. Values from different `postDecode` programs cannot be combined.
