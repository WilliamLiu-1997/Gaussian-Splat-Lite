# Lighting (experimental)

[Back to documentation](../README.md#documentation)

`GaussianSplatRenderer` supports diffuse lighting from your Three.js scene on native WebGPU, WebGL2, and `WebGPURenderer`'s WebGL2 fallback, in sorted and [stochastic](StochasticRendering.md) rendering.

```js
import * as THREE from "three";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  lighting: true,
});
const model = new SplatMesh({ url: "/assets/model.spz" });
const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.position.set(3, 6, 4);
scene.add(splatRenderer, model, sun, sun.target);
scene.add(new THREE.AmbientLight(0xffffff, 1));
```

Lighting is disabled by default. Set `splatRenderer.lighting = true` to enable it for every visible Splat model, including streamed batches.

Changing `lighting` selects the lit or unlit material before rendering. Three.js compiles draw shaders on first use. Native WebGPU first precompiles one plain and one shaded projection slot for both mono and WebXR stereo. Await `splatRenderer.update({ scene, camera })` before the first render to finish this initial preparation; the remaining slots compile in the background at startup. Lighting toggles and XR entry use completed slots without triggering compute compilation.

With on-demand rendering, request a render after changing a light.

## Shading

`AmbientLight`, `HemisphereLight`, `DirectionalLight`, `PointLight`, and `SpotLight` are supported, including distance, decay, and spot-cone attenuation. Visibility and camera layers determine which lights contribute. Light storage grows to fit the contributing lights. Native WebGPU uses a read-only storage buffer, bounded by the device's buffer limits; WebGL and WebGL fallback use a floating-point data texture of up to 2048 × 2048 records, over a million lights for one view. Ambient lights are combined separately.

Normals treat each Gaussian's covariance ellipsoid as a solid surface. At its central visible point, the outward normal is `normalize(inverse(covariance) × towardViewer)`. Spherical Splats naturally face the camera; elongated Splats use all three axes, and thin Splats tend toward their thinnest axis except at grazing views. Orthographic views use a parallel viewing direction. Zero-width axes use a small relative width because their covariance is singular.

Lighting is evaluated at the Splat center in the vertex shader and stays uniform across its footprint:

```text
litColor = splatColor × irradiance / PI
```

Lighting uses linear color, even when Splats blend in sRGB. Light colors must also be linear, as they are with Three.js's default working color space. If you set `ColorManagement.workingColorSpace = THREE.SRGBColorSpace`, convert light colors with `convertSRGBToLinear()` after assigning them. The viewer handles this when switching backends.

A white ambient light with intensity `Math.PI` preserves the original colors. Without illumination, lit models are black. Splat colors, including spherical harmonics, act as surface colors; illumination already baked into captured models remains embedded in them.

This is approximate diffuse shading. It does not recover materials, highlights, or reflections, and Splats do not cast or receive shadows. Estimated normals can be inaccurate, and large Splats near a light or spotlight boundary receive only the illumination at their center. WebXR uses each eye's own viewpoint.

## Cost

Every contributing light adds vertex-shader work for the four vertices of each Splat quad. Zero-intensity lights are excluded from the light records. Lighting adds no fragment-shader light loop. Native WebGPU starts with a one-texel normal texture for precompilation, then stores a 4-byte normal per Splat and eye when lighting is enabled. Ambient-only draws skip the normal: native WebGPU does not read its texture, and both WebGL paths do not estimate it. Storage is retained across lighting toggles until explicit shrinking.

Moving lights or the camera, and changing light colors or intensities, updates the light records. Unchanged float32 records skip GPU uploads. Light storage grows geometrically to avoid reallocating for every added light, and retains capacity when lights are removed or hidden. Growing the storage does not request a shader rebuild. Call `await splatRenderer.shrinkResources({ scene, camera })` to reduce light storage to the current visible lights. Shrinking preserves both cached lit materials and their pipelines, including while lighting is disabled. Native WebGPU keeps every precompiled compute node and pipeline, updates their existing bindings, and shrinks inactive normal storage to one texel. Its texture object stays alive so enabling lighting can restore storage without rebuilding compute shaders.

Light storage uses a fixed shader interface and resizing it does not request shader recompilation. Three.js still includes its scene-light graph in node draw caching, so adding, removing, showing, or hiding scene lights can rebuild node draw shaders. First use of a material, camera layout, or render-target configuration can also compile a draw variant. Light changes do not recompile compute kernels or invalidate Splat projection, compaction, or sorting. Frame cost depends on the backend, light count, model, and view.

[SplatCapture](SplatCapture.md) follows the display renderer's lighting state and evaluates lights from the capture camera.

## Viewer

The built-in **Example** enables three red, green, and blue point lights shown as colored spheres. **Render options → Lighting** controls their rotation, ambient brightness, and intensity, with defaults of `0.35` ambient brightness and `2` light intensity. Loading your own file or URL disables the lights and hides these example controls.

The lights follow the model's framing, with a decay exponent of `1` and a cutoff distance of four times the framing radius. See `examples/viewer/lighting.js` for the demo setup.
