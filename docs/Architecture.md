# Source architecture

[Back to documentation](../README.md#documentation)

`src/index.ts` defines the public exports. Shared code is grouped by responsibility; graphics backends live under `rendering/`.

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

| Owner | Responsibility |
| --- | --- |
| `GaussianSplatRenderer` | Updates, accumulator handoff, sorting, stochastic state, and companion depth |
| `SplatAccumulator` | Scene mappings, versions, camera-relative data, and generation |
| `StochasticResolvePass` | Scene composition, XR eye atlas, and renderer-state restoration |
| WebGL backend | GLSL materials, ordering textures, array-target generation, readback, and PMREM |
| WebGPU backend | TSL materials, compute generation, ordering buffers, GPU sorting, readback, and PMREM |

The backend is selected at construction. Worker/WASM sorting is shared and remains the default on both backends.

Resource rules:

- Keep ordering buffers owned by the GPU sorter during handoff to worker results.
- Wait for outstanding GPU compilation before disposing the sorter.
- Preserve WebGPU compute nodes when resizing buffers and textures.
- Keep backend-specific color and XR output handling with each backend.

WebGPU shaders are split into `SplatMaterial.ts` (drawing), `GenerateProgram.ts` (generation), `ResolveMaterial.ts` (resolve), and `shaderUtils.ts` (helpers). WebGL shaders live under `webgl/shaders/`.

## Imports and extensions

- Applications import from `gaussian-splat-lite`, including `utils` and `defines`. Source paths are internal.
- Internal modules import helpers from their owner; `utils/index.ts` is the public entry only.
- Keep scene updates, sorting handoffs, and stochastic transitions in shared rendering code.
- Keep options, types, and small helpers beside their owner. TSL types belong in `webgpu/`.
- Shared uniform defaults must not import backends. The GPU sorter reads texture defaults from `data/`.
- Separate numeric codecs from Three.js object unpacking so decode workers avoid scene dependencies.
