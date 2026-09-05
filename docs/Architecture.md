# Source architecture

[Back to the API overview](../README.md#core-concepts-and-public-api)

`src/index.ts` is the public package entry. Implementations are grouped by
responsibility, with backend-specific rendering code under `webgl/` and
`webgpu/`. The package exports and application imports remain the same.

| Directory | Responsibility |
| --- | --- |
| `src/data/` | Packed Splat data, codecs, texture layout and CPU unpacking |
| `src/scene/` | Scene objects, mesh transforms, raycasting and SDF edits |
| `src/loaders/` | File loading, decode requests and post-decode expression programs |
| `src/runtime/` | Worker RPC, pooling, transferable discovery and WebAssembly initialization |
| `src/utils/` | Numeric conversion, spatial transforms, Three.js helpers and the public utility namespace |
| `src/rendering/` | Shared renderer, accumulator, sort cache, stochastic resolve and backend selection |
| `src/rendering/webgl/` | GLSL materials, array-target generation, ordering textures, uploads and readback |
| `src/rendering/webgpu/` | TSL materials, compute generation, radix sorting, storage buffers, readback and compatibility patches |

## Rendering boundaries

`GaussianSplatRenderer` coordinates update requests, display/current accumulators,
sorting transitions and stochastic state. It delegates material creation,
ordering storage, pixel readback and PMREM creation to a backend selected once
at construction. Backend-specific blend-space and XR output rules are also kept
with those backends.

The WebGL backend owns its ordering texture and partial row uploads. The WebGPU
backend owns its storage-buffer binding, sorter and precompilation lifetime.
The worker/WASM sorting path stays shared: WebGPU can use it too. GPU ordering
buffers remain owned by the sorter during a handoff to worker results, and sorter
disposal still waits for outstanding compilation.

`SplatAccumulator` owns scene mappings, version checks and camera-relative data.
WebGL generation draws into array render targets; WebGPU generation dispatches a
fixed compute graph into storage textures. GPU buffer/texture resizing preserves
the existing compute nodes.

`StochasticResolvePass` owns the scene-to-resolve flow, reusable XR eye atlas and
renderer-state restoration. Its GLSL and TSL materials live in their respective
backend directories. XR auto stochastic stays disabled; manual stochastic and
per-eye resolve use the existing behavior.

Shared render modules sit together in `rendering/`; only concrete backend code
goes into `webgl/` or `webgpu/`. Common uniform defaults do not import backend
implementations, and the GPU sorter reads texture defaults directly from the
data module. Renderer options and resolve-state types live beside their owners;
TSL-specific types stay inside `webgpu/`.

WebGPU shader code is split into Splat drawing (`SplatMaterial.ts`), accumulator
generation (`GenerateProgram.ts`), resolve (`ResolveMaterial.ts`) and shared TSL
helpers (`shaderUtils.ts`). WebGL GLSL sources live under `webgl/shaders/`.

## Imports and extensions

Applications continue importing from `gaussian-splat-lite`. The existing `utils`
and `defines` namespaces are preserved. Internal modules import helpers directly
from the directory that owns them; `utils/index.ts` is only the public compatibility
surface. Source-file paths are internal and are not additional package exports.

Keep backend resource management in the corresponding backend directory and
cross-backend state transitions in shared orchestration. Scene updates, sorting
handoffs and stochastic transitions share one implementation.

Keep small helpers with their owning module: worker reuse and idle policy live
with the worker pool. Numeric packing and matrix transforms each have one utility
module. Pure numeric Splat codecs stay separate from Three.js object unpacking
so decode workers do not need scene-object dependencies.

The Rust workspace, example viewer and build scripts retain their existing
directories. Worker entry points, inline-worker imports and declaration output
follow the new source paths.
