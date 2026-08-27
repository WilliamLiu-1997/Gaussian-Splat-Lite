# SplatAccumulator

[Back to the API overview](../README.md#core-concepts-and-public-api)

`SplatAccumulator` is the low-level GPU generation buffer used by `GaussianSplatRenderer` to combine visible `SplatMesh` objects into renderable texture arrays. Applications normally should not construct or update it directly.

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
| `getTextures()` | Returns the two generated standard-layout Splat data textures, or empty fallback textures before allocation |
| `generateMapping(splatCounts)` | Assigns texture-row-aligned ranges and returns their required capacity |
| `ensureGenerate({ maxSplats })` | Allocates or grows the generation target; returns whether a new target was created |
| `generate({ mesh, base, count, renderer })` | Generates one mesh into its assigned accumulator range |
| `prepareGenerate({ renderer, scene, timer, camera, previous })` | Collects visible meshes, runs frame updates, compares versions, and returns a deferred generation plan |
| `checkVersions(mapping)` | Reports generated-data, mapping, and sorting changes relative to another mapping |
| `dispose()` | Releases the render target and drops retained mesh mappings |

`prepareGenerate()`, `generate()`, and version management are renderer plumbing. Use `GaussianSplatRenderer.update()` for normal manual updates.
