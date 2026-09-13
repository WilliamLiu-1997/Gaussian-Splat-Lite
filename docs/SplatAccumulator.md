# SplatAccumulator

[Back to documentation](../README.md#documentation)

Combines visible Splat models for rendering. `GaussianSplatRenderer` manages this automatically; most applications only need its `update()` method.

For custom integrations, the methods below expose the combined scene data. `ensureGenerate()` and `generate()` support WebGL only.

## Constructor

```ts
new SplatAccumulator()
```

## Common state

| Property | Description |
| --- | --- |
| `numSplats` | Number of Splats in the combined data |
| `maxSplats` | Allocated Splat capacity |
| `mapping` | Models and their ranges in the combined data |
| `version` | Combined data version |
| `mappingVersion` | Model mapping version |
| `viewOrigin` / `viewDirection` | Camera position and direction used for the current data |
| `time` / `deltaTime` | Timer values used for per-frame mesh updates |

## Common methods

| API | Description |
| --- | --- |
| `getTextures()` | Return the combined Splat textures |
| `generateMapping(splatCounts, compact?)` | Assign model ranges and return the required capacity; `compact` reduces unused space |
| `ensureGenerate({ maxSplats, renderer?, shrinkResources? })` | Prepare storage for the requested capacity; optionally shrink unused resources |
| `generate({ mesh, base, count, renderer })` | Update one model's range in the combined data |
| `prepareGenerate({ renderer, scene, timer, camera, previous })` | Collect visible models and prepare their updates |
| `checkVersions(mapping)` | Check whether data, model ranges, or sorting need updating |
| `dispose()` | Release this accumulator's resources |
