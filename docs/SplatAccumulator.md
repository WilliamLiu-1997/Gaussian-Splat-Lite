# SplatAccumulator

[Back to documentation](../README.md#documentation)

Low-level GPU storage for combining visible Splat meshes. Applications normally use `GaussianSplatRenderer.update()` instead.

Native WebGPU deferred generation submits meshes in batches using 8 reusable compute nodes per accumulator. `GaussianSplatRenderer` creates all slots and starts `compileComputeAsync()` when its accumulators are initialized; the first update waits for their precompilation to finish. Each node has independent uniforms and texture bindings, while all nodes share the accumulator's output textures. Nodes and pipelines are reused across scene changes and texture resizing. Disposal during precompilation releases resources after compilation settles. All visible meshes are generated in the same update, including the final partial batch. Direct calls to `generate()` still submit immediately once any requested precompilation has finished.

The WebGPURenderer WebGL2 fallback rasterizes the same TSL generation program into integer array render targets. Both WebGL paths pad each mesh to texture rows and use CPU sorting. The pinned Three.js fallback build requires at least two array layers, so fallback accumulator textures reserve a second layer even for smaller scenes.

## Constructor

```ts
new SplatAccumulator()
```

## Common state

| Property | Description |
| --- | --- |
| `numSplats` | Number of valid Splats in the current combined buffer |
| `maxSplats` | Allocated Splat capacity |
| `mapping` | `SplatMapping[]` entries associating each visible mesh with its buffer range and versions |
| `version` | Combined generated-data version |
| `mappingVersion` | Combined mesh-to-buffer mapping version |
| `viewOrigin` / `viewDirection` | Camera position and direction used by the current generation pass |
| `time` / `deltaTime` | Timer values used for per-frame mesh updates |

## Common methods

| API | Description |
| --- | --- |
| `getTextures()` | Returns the two generated standard-layout Splat textures, or empty fallback textures before allocation |
| `generateMapping(splatCounts, compact?)` | Assigns ranges and returns their required capacity; compact ranges omit per-mesh row padding |
| `ensureGenerate({ maxSplats, renderer?, shrinkResources? })` | Allocates, grows, or optionally shrinks the backend-appropriate GPU storage |
| `precompileGenerate(renderer)` | Starts native WebGPU generation precompilation once; await `generateReady` before direct generation and inspect `generateError` for failure; no-op on WebGL |
| `generate({ mesh, base, count, renderer })` | Generates one mesh into its assigned accumulator range |
| `prepareGenerate({ renderer, scene, timer, camera, previous })` | Collects visible meshes, runs frame updates, compares versions, and returns a deferred generation plan |
| `checkVersions(mapping)` | Reports generated-data, mapping, and sorting changes relative to another mapping |
| `dispose()` | Releases accumulator GPU storage and drops retained mesh mappings |
