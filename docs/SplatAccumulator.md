# SplatAccumulator

[Back to documentation](../README.md#documentation)

Low-level scene mappings and WebGL GPU storage for combining visible Splat meshes. Applications normally use `GaussianSplatRenderer.update()` instead.

Native WebGPU uses this class only for scene mappings, edit metadata and the camera-relative origin. Texture generation is WebGL-only; `ensureGenerate()` and `generate()` reject native WebGPU renderers.

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
| `ensureGenerate({ maxSplats, renderer?, shrinkResources? })` | Allocates, grows, or optionally shrinks accumulator GPU storage |
| `generate({ mesh, base, count, renderer })` | Generates one mesh into its assigned accumulator range |
| `prepareGenerate({ renderer, scene, timer, camera, previous })` | Collects visible meshes, runs frame updates, compares versions, and returns mappings and a deferred generation plan |
| `checkVersions(mapping)` | Reports generated-data, mapping, and sorting changes relative to another mapping |
| `dispose()` | Releases accumulator GPU storage and drops retained mesh mappings |
