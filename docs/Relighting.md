# Relighting

[Back to documentation](../README.md#documentation)

`SplatRelight` adds diffuse lighting from Three.js scene lights. It is an optional [shader effect](ShaderEffects.md), with the same behavior on WebGPU, WebGL2, and `WebGPURenderer`'s WebGL2 fallback.

```js
import * as THREE from "three";
import { GaussianSplatRenderer, SplatRelight } from "gaussian-splat-lite";

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  effect: new SplatRelight(),
});

const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.position.set(3, 6, 4);
scene.add(splatRenderer, sun, sun.target);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

// Restore the captured appearance:
// splatRenderer.effect = null;
```

Supported lights are `AmbientLight`, `HemisphereLight`, `DirectionalLight`, `PointLight`, and `SpotLight`. Their visibility, camera layers, colors, intensities, distance attenuation, and spot cones apply. Light colors must be linear, as in Three.js's default working color space.

Light changes take effect on the next render. A white ambient light with intensity `Math.PI` preserves the original colors; without light, affected Splats are black. Request a new render after changing lights when using on-demand rendering.

This is approximate diffuse lighting. Captured shadows and highlights remain embedded in the source colors. The effect does not recover materials, produce specular reflections, or cast or receive shadows. Estimated normals can change with the viewpoint, and large Splats receive one lighting value across their footprint.

The effect covers every visible Splat model displayed by the renderer, including streamed models and captures. It occupies the renderer's single `effect` slot. Custom combinations can use `SplatRelight.create(renderer)` in an effect factory and wrap its hooks; forward its `onBeforeRender` and `dispose` callbacks.

In the viewer, load the example and open **Render options → Lighting** to toggle the three colored lights, pause their rotation, or adjust ambient brightness and light intensity. The example enables animated lights with ambient brightness `0.35` and intensity `2`. Loading a local file or URL disables the lights and hides these example controls.
