# Lighting and shadows (experimental)

[Back to documentation](../README.md#documentation)

`SplatLightingPlugin` lights Splats with your scene's Three.js lights and lets Splat models cast and receive shadows together with ordinary meshes. Import it separately from `gaussian-splat-lite/plugins` and register it with your `GaussianSplatRenderer`. It works on WebGPU, WebGL2, and `WebGPURenderer`'s WebGL2 fallback, in sorted and in [stochastic](StochasticRendering.md) rendering. The main package includes no lighting or shadow implementation.

## Turn it on

```js
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";
import { SplatLightingPlugin } from "gaussian-splat-lite/plugins";

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const splatRenderer = new GaussianSplatRenderer({ renderer });
const lighting = new SplatLightingPlugin();
splatRenderer.registerPlugin(lighting);

const model = new SplatMesh({ url: "/assets/model.spz" });
lighting.setModelOptions(model, {
  castShadow: true,
  receiveShadow: true,
});

const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
// Fit sun.shadow.camera to your scene, as for any Three.js shadow.

scene.add(splatRenderer, model, sun, sun.target);
scene.add(new THREE.AmbientLight(0xffffff, 1));
```

The plugin is enabled by default. Pass `{ enabled: false }` to its constructor or set `lighting.enabled` at any time. Register one plugin instance per renderer; `splatRenderer.unregisterPlugin(lighting)` removes it, and disposing the renderer disposes its plugins. Without a registered plugin, the renderer allocates no lighting or shadow resources.

Use `lighting.setModelOptions(object, options)` to choose how a model or group takes part. These options belong to the plugin and can be changed at any time:

| Option | Default | Description |
| --- | --- | --- |
| `receiveLight` | `true` | Light this model. `false` keeps its original colors, without shadows on it |
| `castShadow` | `false` | Cast shadows onto Splats and meshes |
| `receiveShadow` | `false` | Receive shadows from Splats and meshes |

Settings on a group apply to its Splat descendants, including batches loaded later. Configure the group of a [RadStreamScheduler](RadStreamScheduler.md) or [SogStreamScheduler](SogStreamScheduler.md) to light the whole streamed scene:

```js
const streaming = new RadStreamScheduler({
  url: "/assets/scene.rad",
});
lighting.setModelOptions(streaming.group, {
  castShadow: true,
  receiveShadow: true,
});
```

The nearest configured ancestor supplies each option, and a model's own plugin settings override its group's settings. Without a plugin setting, `receiveLight` defaults to `true`, and shadows follow the model's inherited Three.js `castShadow` and `receiveShadow` properties. `lighting.getModelOptions(object)` returns the resolved settings. With on-demand rendering, request a render after changing settings or a light.

## Lights

`AmbientLight`, `HemisphereLight`, `DirectionalLight`, `PointLight`, and `SpotLight` are supported, with their colors, intensities, distances, and spot cones.

Lighting is diffuse only. A Splat's color, including its view-dependent color, acts as the color of its surface:

- A white `AmbientLight` with intensity `Math.PI` leaves colors as they are. Without any light, lit models are black.
- Most captured models already contain the lighting they were captured in. Scene lights are added on top; they do not remove it.
- The surface is estimated from each Splat's shape: its thinnest direction is the normal. Large Splats, or Splats seen from the side, can be shaded inaccurately.

Lighting is computed in linear color, whichever color space Splats are blended in. Light colors must be linear as well. They are with Three.js's default working color space. If you set `ColorManagement.workingColorSpace` to sRGB, as the viewer does with `WebGPURenderer`, convert each light color with `convertSRGBToLinear()`.

## Shadows

Enable shadows as you would for meshes: `renderer.shadowMap.enabled`, `castShadow` on the light, and the model options above. Meshes keep their own `castShadow` and `receiveShadow`, and Splats and meshes shadow each other.

- `PCFShadowMap`, `BasicShadowMap`, and `VSMShadowMap` work. Three.js does not offer VSM for point lights.
- Partly transparent Splats cast partial shadows through a fixed noise pattern, which can look grainy with `BasicShadowMap`; the other types smooth it.
- Model opacity and [SDF edits](SplatEdit.md) apply to shadows, and shadows follow a model's transform in the same frame.
- A model's soft surface is many overlapping Splats, which can shadow each other in patches. Raise the light's `shadow.normalBias`, in scene units, to reduce this, and tune `shadow.bias` to adjust the depth comparison.
- Shadow maps and `shadow.autoUpdate` are Three.js's own, and Splats filter them as meshes do, with the light's `shadow.radius`, `shadow.blurSamples`, and `shadow.intensity`. Each shadow-casting light draws every casting model again, and a point light draws them for six directions.
- Lights and shadows keep their precision far from the world origin, as in ECEF scenes. As for meshes, keep a directional light's shadow camera close to what it lights: depth precision falls with its distance.
- `WebGPURenderer`'s `CSMShadowNode` cascaded shadow maps work, including cascade fading. Other custom `shadow.shadowNode` implementations do not shadow Splats; Splats still cast shadows into their maps.
- With `WebGPURenderer`, `shadowMap.transmitted` also carries the caster's shadow color to Splats.
- Shadow bias reverses with reversed depth on all backends, so negative bias reduces self-shadowing with either depth convention.

## Performance and limits

Lighting shades every Splat fragment, so it costs noticeably more than unlit rendering, and each shadow view adds another pass over the casting models. Keep shadow-casting lights few, and prefer one directional or spot light over point lights when speed matters.

Casting models prepare source textures and transforms once per scene render, shared across its lights and shadow views. For static scenes, set a light's `shadow.autoUpdate = false` after its first shadow render, and set `shadow.needsUpdate = true` when the light, a caster, SDF edits, or streamed LOD data changes. Moving the color camera alone does not require refreshing these lights' shadow maps.

On WebGPU, lighting stores 16 more bytes for each Splat in view.

With `WebGPURenderer`, avoid drawing one scene through cameras whose layers select different lights. Three.js then rebuilds the scene's shaders for every render, lit or not.

[SplatCapture](SplatCapture.md) captures follow the registered plugin's enabled state and model settings.

## WebXR

Lighting and shadows need no extra setup in WebXR. Each eye is lit and shadowed from its own viewpoint, and shadow maps are drawn once for both eyes.

## In the viewer

Run `npm run dev` and open **Render options → Lighting & shadows**:

- **Spotlight** turns on one light moving back and forth along a horizontal 180° arc above the model's front, aimed at its center, with a cone-shaped lamp and a lens that matches its color. It smoothly cycles through red, green, and blue over nine seconds. Loading the built-in **Example** enables it. The viewer hides the lighting options and disables this light when loading your own file or URL.
- **Rotate light** pauses or resumes its motion; its color continues changing.
- **Cast / receive shadows** controls the light's shadows.
- **Ambient brightness** and **Light intensity** adjust the illumination; the default light intensity is `1`.

The light follows the loaded model's framing and uses one 256 × 256 PCF shadow map. Files and streamed scenes cast and receive shadows alike. The repository's `examples/viewer/lighting.js` builds it.

The viewer starts with stochastic rendering and TAA enabled. Its lighting plugin is enabled for the built-in example; registering the plugin is optional for library users, and the renderer's `stochastic` option remains off by default.

When **Rotate light** is off, the viewer reuses the shadow map until Splat data, transforms, opacity, or shadow quality changes. While they keep changing, as streamed detail does under a moving camera, it redraws at most five times a second. Scenes with SDF edits, per-frame model callbacks, or ordinary mesh casters continue updating their shadows automatically.
