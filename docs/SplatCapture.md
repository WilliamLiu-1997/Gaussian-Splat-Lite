# SplatCapture

[Back to documentation](../README.md#documentation)

Renders a scene and its Splats offscreen: into a render target, as pixels you can read back, as a cube map, or as an environment map for reflections. It works with `WebGLRenderer` and with `WebGPURenderer` on both WebGPU and its WebGL2 fallback.

```js
import { SplatCapture } from "gaussian-splat-lite";

const capture = new SplatCapture({
  splatRenderer, // The GaussianSplatRenderer already in your scene.
  target: { width: 1920, height: 1080 },
});

const rgba = await capture.renderReadTarget({ scene, camera });
// Uint8Array of 1920 × 1080 × 4 bytes, bottom row first.
```

Captures do not disturb what is on screen. Your render loop can keep running while one is in progress, and the display keeps its own camera and settings.

[SDF edits](SplatEdit.md) apply to captures as they do on screen, whether they are attached to the scene or to a model.

Registered plugins with capture support follow the display renderer. The optional [SplatLightingPlugin](Lighting.md) carries its enabled state and model settings into captures while keeping its rendering resources separate.

Coming from 1.1.8? These were methods and options of `GaussianSplatRenderer`. They keep the same names on `SplatCapture`, except the cube captures' `update` option, which is gone: every capture shows the current scene and reuses earlier work while nothing has changed.

## Render to a target

Pass `target` to capture 2D images. It accepts the options below plus `THREE.RenderTargetOptions`, except `stencilBuffer`, which follows the Three.js renderer.

| Option | Default | Description |
| --- | --- | --- |
| `width` / `height` | Required | Image size in pixels |
| `superXY` | `1` | Supersampling, an integer from 1 to 4. The scene renders at `superXY` times the size on each axis and is averaged down when read back |
| `doubleBuffer` | `false` | Alternate between two targets, so `capture.target` keeps a finished image while the next one renders |

`width` and `height` multiplied by `superXY` can be at most 8192.

| Method | Description |
| --- | --- |
| `renderTarget({ scene, camera })` | Render the view and return the `THREE.RenderTarget` holding it |
| `readTarget()` | Read the latest render as RGBA bytes |
| `renderReadTarget({ scene, camera })` | Do both in one call |

`capture.target` always holds the latest finished render. Use `capture.target.texture` as a texture; its size includes supersampling.

Pixels come back as a `Uint8Array` of `width × height × 4` bytes, bottom row first, in the same layout on every renderer. The array is reused by later reads, so copy it with `rgba.slice()` if you need to keep it.

Targets are 8-bit RGBA in sRGB unless you say otherwise:

- `samples` antialiases the meshes in the scene.
- Stencil masking follows the Three.js renderer's stencil setting. Stencil settings on your Splat renderer's `material` apply to the Splats in the capture too.
- `type: THREE.HalfFloatType` or `THREE.FloatType` keeps values above 1. Such targets can be rendered but not read back; reading requires 8-bit RGBA.

2D captures also keep the scene's depth in the target.

## Cube maps and environment maps

```js
const cube = await capture.renderCubeMap({
  scene,
  worldCenter: new THREE.Vector3(0, 1, 0),
  size: 256,
  hideObjects: [reflectiveMesh],
});
const faces = await capture.readCubeTargets(); // Six RGBA arrays.

const envMap = await capture.renderEnvMap({
  scene,
  worldCenter: reflectiveMesh.getWorldPosition(new THREE.Vector3()),
  hideObjects: [reflectiveMesh],
});
capture.recurseSetEnvMap(reflectiveMesh, envMap);
```

`target` is not needed when you only capture cube or environment maps.

| Method | Description |
| --- | --- |
| `renderCubeMap(options)` | Render the six directions around a point and return a `THREE.CubeTexture` |
| `readCubeTargets()` | Read the latest cube map as six RGBA arrays |
| `renderEnvMap(options)` | Render a cube map and filter it into an environment map ready for `material.envMap` |
| `recurseSetEnvMap(root, envMap)` | Assign an environment map to every `MeshStandardMaterial` under `root` |

| Option | Default | Description |
| --- | --- | --- |
| `scene` | Required | Scene to capture |
| `worldCenter` | Required | Capture position in world space |
| `size` | `256` | Size of each face in pixels, up to 8192 |
| `near` / `far` | `0.1` / `1000` | Clipping distances |
| `hideObjects` | `[]` | Objects to leave out of the capture, such as the mesh that will show the reflection. Their children, Splat models included, are left out too, except SDF edits, which still apply. They stay visible on screen |
| `filter` | `false` | `renderCubeMap()` only. Capture linear color with mipmaps, for filtering the cube map into an environment map yourself |

Cube faces are read in +X, −X, +Y, −Y, +Z, −Z order, with the same layout on every renderer. Each side face starts with its top (+Y) row.

Cube and environment captures show the objects on Three.js layer 0.

## Moving reflections

To keep a reflection up to date while an object moves, start a capture from your render loop without awaiting it, and keep showing the previous environment map until the next one is ready. Run one capture at a time. For a `MeshStandardMaterial` with `WebGLRenderer`:

```js
let reflectionPending = false;
let nextCaptureTime = 0;

renderer.setAnimationLoop((time) => {
  // Update the sphere's position and other animation here.
  if (!reflectionPending && time >= nextCaptureTime) {
    reflectionPending = true;
    nextCaptureTime = time + 100; // Adjust the update interval for your scene.
    capture.renderEnvMap({
      scene,
      worldCenter: sphere.getWorldPosition(new THREE.Vector3()),
      hideObjects: [sphere],
      size: 256,
    }).then((envMap) => {
      const previous = sphere.material.envMap;
      capture.recurseSetEnvMap(sphere, envMap);
      previous?.dispose();
    }).catch(console.error).finally(() => {
      reflectionPending = false;
    });
  }
  renderer.render(scene, camera);
});
```

With `WebGPURenderer`, use a `MeshStandardNodeMaterial` and assign one `pmremTexture(envMap)` node to `material.envNode`. For each later capture, set that node's `.value` to the new environment map, then dispose the old one.

Each capture draws the scene six times, so update reflections less often than you render.

## Good to know

- **Await the result.** Every render and read method returns a promise.
- **The view is fixed when you call.** A capture uses the camera or `worldCenter` as it was at the call, even if it moves before the capture finishes.
- **Captures run in order.** A call made while another capture is in progress waits for it.
- **Splat settings follow your renderer.** Captures use the quality and blending options of the `splatRenderer` you passed in.
- **Stencil follows your renderer.** 2D, cube, and environment captures enable their stencil buffers when the Three.js renderer does. No capture option is needed. A 2D target created with `depthBuffer: false` has no stencil buffer either.
- **Captures always use sorted rendering,** also when the display uses [stochastic rendering](StochasticRendering.md).
- **Colors match the screen.** Splats blend as they do when the same renderer draws to the canvas, and the image is stored in the target's color space. Environment maps are linear.
- **Animation does not advance.** Captures do not call [`onFrame`](SplatMesh.md#scene-integration); only your display renders do.
- **Visibility and layers apply.** Models appear according to their visibility and the capture camera's layers.

## Cleanup

`capture.dispose()` releases the targets, cube maps, and other memory the capture holds. It does not dispose your Splat renderer or models.

- The cube texture from `renderCubeMap()` belongs to the capture. Later calls redraw the same texture, or replace it when `size`, `near`, `far`, or the renderer's stencil setting change. `renderEnvMap()` leaves it untouched unless you captured it with `filter: true`.
- Environment maps from `renderEnvMap()` belong to you. Call `envMap.dispose()` when you are done with one.
