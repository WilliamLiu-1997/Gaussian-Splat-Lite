# StochasticTAAPass

[Back to documentation](../README.md#documentation)

Reduces stochastic noise across frames for one [GaussianSplatRenderer](GaussianSplatRenderer.md). Supports WebGL, WebGPU, and WebGPURenderer's WebGL2 fallback.

```js
import { StochasticTAAPass } from "gaussian-splat-lite";

splatRenderer.stochastic = true;
const taa = new StochasticTAAPass(splatRenderer);
renderer.setAnimationLoop(() => taa.compose(renderer, scene, camera));
```

This pass accumulates independent Splat samples over time. The pass preserves the renderer's mode: manual stochastic mode accumulates even while stationary; Auto uses this pass during motion/settling and returns to sorted rendering when sorting finishes; sorted mode renders normally without TAA.

Splats render into their own color and depth textures. TAA processes only those textures, then a depth-tested composite draws after opaque geometry and before transparent geometry. Ordinary objects never enter the Splat history, including transparent objects overlapping Splats. All three backends traverse the ordinary scene once per view. The camera projection and `splatRenderer.renderDepth` setting stay unchanged.

## Properties and methods

| API | Description |
| --- | --- |
| `splatRenderer` | Bound renderer; assigning another renderer discards history |
| `enabled` | Default `true`; disabling bypasses the entire pass and draws directly |
| `temporalEnabled` | Default `true`; `false` retains quad spatial resolve without temporal accumulation |
| `compose(renderer, scene, camera)` | Accumulate Splats separately and composite the scene to the current target or canvas |
| `resetHistory()` | Discard history after camera cuts, model edits, or scene changes |
| `requestRender()` | Schedule 256 more stochastic samples without discarding history |
| `needsRender` | Whether an on-demand loop should keep drawing |
| `dispose()` | Release targets, materials, and the binding |

## Frame history

In manual stochastic mode, a stationary camera accumulates up to 256 samples per pixel. During camera movement, spatial resolve combines the stratified samples with reprojected history, capped at 16 samples and reduced further by image motion. Returning to rest resumes full-resolution temporal accumulation. Updated Splat content also lowers the history cap to 16 so newly loaded detail appears sooner. Empty samples contribute zero color and coverage; their history fades rather than being discarded immediately.

For on-demand rendering, call `requestRender()` after scene/camera updates and keep drawing while `needsRender` is true. Camera movement automatically extends accumulation until the view settles. A continuous stochastic render loop continues sampling even after the history reaches its cap. Auto stops accumulation when the sorted replacement becomes available.

The stationary accumulation assumes the Splat content is stationary. Call `resetHistory()` after moving/editing Splats, changing their appearance, or making a camera cut. Ordinary opaque and transparent objects can move without resetting Splat history. View, size, scene, renderer, and color-configuration changes reset history automatically. Motion and layered Splat transparency can still produce some softened detail or ghosting.

Set `taa.temporalEnabled = false` to turn off TAA while keeping spatial reconstruction, as the viewer's TAA switch does. Each frame resolves the current 2×2 quad samples and interpolates between quad centers. The random seed stays fixed; no history pass runs and `needsRender` is false. Missing samples use the nearest depth in their own quad for composition. Turning temporal accumulation back on starts fresh history. Sorted rendering still draws directly in either setting.

## Render targets and depth

With temporal accumulation, composition uses the accumulated mean Splat depth on both current-frame hits and misses. Valid hits update the mean with the same sample-count weight used for color accumulation; empty samples retain the previous mean instead of adding far-plane depth. During camera motion, the carried depth is adjusted into the current view before accumulation. The existing stationary/moving sample caps control the response speed. Spatial-only mode continues using current-frame depth.

During camera motion, the existing 3×3 color-clamping neighborhood also bounds the mean depth to the range of current covered samples. An entirely empty neighborhood clears the depth. This removes old occluders outside the current local depth range immediately, instead of slowly blending them away. Mixed-depth edges can still retain stale depth within that range, and rejecting history can reintroduce some flicker.

Temporal composition preserves faint color but writes depth only where accumulated alpha is at least `0.1`. Color still depth-tests against opaque geometry. This uses a separate fullscreen depth-only draw, without another Splat draw, render target, or sort. Spatial-only composition is unchanged. The cutoff reduces excessive occlusion in faint regions, but crossing the threshold can produce a visible occlusion boundary.

The mean reuses the existing history attachment. It smooths depth fluctuations but remains a representative-depth approximation: a mean between Splat layers can incorrectly occlude geometry between those layers. It is not a deterministic alpha-composited depth. Call `resetHistory()` after Splat edits or camera cuts as described above; ordinary objects remain outside the Splat history.

`compose()` writes to the current render target or canvas. Targets with `depthBuffer` also receive the current scene depth for later geometry to depth-test against. Canvas output does not receive scene depth; include depth-tested geometry in the composed scene.

## EffectComposer

For WebGL post-processing (non-XR), compose into `composer.readBuffer` first:

```js
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const composer = new EffectComposer(renderer);
// Add post-processing effects here, before OutputPass.
composer.addPass(new OutputPass());

renderer.setAnimationLoop(() => {
  renderer.setRenderTarget(composer.readBuffer);
  taa.compose(renderer, scene, camera);
  renderer.setRenderTarget(null);
  composer.render();
});
```

Keep only post-processing passes in the composer; omit `RenderPass` and `StochasticTAAPass`. Read `composer.readBuffer` each frame because the buffers swap.

## ArrayCamera and WebXR

Each view has independent history. For WebXR, use the same `compose()` loop with `splatRenderer.stochastic = true` and `splatRenderer.autoStochastic = false`.

Memory and rendering work increase with the number and resolution of views.
