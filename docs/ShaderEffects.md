# Shader effects

[Back to documentation](../README.md#documentation)

Use `SplatShaderEffect` to customize Splat colors and transparency. Assign it with `new GaussianSplatRenderer({ renderer, effect })` or `splatRenderer.effect = effect`. Set `effect = null` to restore ordinary rendering.

An effect applies to all Splats displayed by that renderer, including streamed models. Sorted, stochastic, and stochastic MSAA rendering use the same hooks. [SplatCapture](SplatCapture.md) follows the source renderer's effect.

## Hooks

All hooks are optional. They run in this order:

| Hook | Input | Return | Use |
| --- | --- | --- | --- |
| `shadeSplat` | Original linear RGB and Splat center | Linear RGB | Diffuse lighting, tinting, height coloring; one color across each Splat |
| `opacity` | Gaussian alpha, shaded color, and fragment coordinates | Alpha | Dissolves, clipping, and transparency masks, before coverage is decided |
| `shadeFragment` | Shaded color and effective alpha | Linear RGB | Shadow-map sampling, texture projection, and detailed lighting on surviving fragments |

Colors are **linear, unpremultiplied RGB**, including HDR values. The renderer handles output conversion and alpha blending. An opacity hook returns the desired alpha, not a multiplier. Its result is clamped to `[0, alpha]`: it can hide existing coverage but cannot expand a Splat or reveal one already culled. `shadeFragment` cannot change alpha or depth.

## Example

Provide `tsl` for `WebGPURenderer` (native WebGPU and WebGL fallback), and `glsl` for classic `THREE.WebGLRenderer`. A missing implementation reports an error when the effect is assigned.

```js
import { vec3, step } from "three/tsl";
import { SplatShaderEffect } from "gaussian-splat-lite";

const brightness = { type: "float", value: 1 };
const effect = new SplatShaderEffect({
  uniforms: { brightness },
  tsl: {
    shadeSplat: ({ color, uniforms }) => color.mul(uniforms.brightness),
    opacity: ({ alpha, splatUv }) => alpha.mul(step(0, splatUv.x)),
    shadeFragment: ({ color }) => color.mul(vec3(1, 0.5, 0.2)),
  },
  glsl: {
    shadeSplat: "return splat.color * effect_brightness;",
    opacity: "return splat.alpha * step(0.0, splat.splatUv.x);",
    shadeFragment: "return splat.color * vec3(1.0, 0.5, 0.2);",
  },
});

splatRenderer.effect = effect;
brightness.value = 2; // Takes effect on the next render.
```

TSL callbacks build shader expressions; they are not JavaScript callbacks executed for every Splat. Each GLSL hook is a function body with a `SplatContext splat` argument. `glsl.declarations` can supply shared helper functions. Uniform declarations are generated automatically with the prefix `effect_`; do not declare them again.

## Context

| Field | Available in | Meaning |
| --- | --- | --- |
| `color` | All hooks | Linear RGB; fragment hooks receive the result of `shadeSplat` |
| `viewCenter` | All hooks | Splat center in the current eye's view space; not a surface intersection |
| `viewNormal` | With `normals: true` | Estimated outward covariance normal, oriented toward the current viewpoint |
| `alpha` | Fragment hooks | Gaussian alpha; `shadeFragment` receives the result of `opacity` |
| `splatUv` | Fragment hooks | Gaussian coordinates, centered at `(0, 0)` |
| `screenUV` | Fragment hooks | Full-framebuffer coordinates in `[0, 1]`, origin at the top left, including render targets |
| `uniforms` | TSL hooks | Typed uniform or texture nodes |
| `camera` | TSL hooks | Camera used to build this shader; use uniforms for changing camera data |

The estimated normal depends on the Gaussian's shape and viewpoint. It is optional and is not a recovered mesh normal. Geometry and positions are read-only in this interface. A fragment hook can sample an application-provided shadow texture; generating shadow maps remains the application's responsibility.

## Uniforms and resources

Each uniform has a `type` and `value`. Supported types are `float`, `int`, `uint`, `bool`, `vec2`, `vec3`, `vec4`, `mat3`, `mat4`, `sampler2D`, and `samplerCube`. Use matching Three.js vectors, colors, matrices, and textures. In TSL, sample texture uniforms with `.sample(uv)` or `.sample(direction)`.

In TypeScript, use `satisfies SplatEffectUniform` for bindings declared outside the effect so their `type` stays a literal and their `value` remains mutable.

Change `.value` or update a vector, color, or matrix to animate an effect without replacing its shaders. Keep uniform names and types fixed. To change shader code or requested inputs, assign a new effect. With on-demand rendering, request a render after changing values.

An effect can be shared by multiple renderers. Use a factory when each renderer needs its own resources:

```js
const effect = new SplatShaderEffect(({ renderer }) => {
  const brightness = { type: "float", value: 1 };
  return {
    uniforms: { brightness },
    tsl: {
      shadeSplat: ({ color, uniforms }) => color.mul(uniforms.brightness),
    },
    glsl: { shadeSplat: "return splat.color * effect_brightness;" },
    onBeforeRender({ scene, camera, splatRenderer }) {
      brightness.value = 0.8;
    },
    dispose() {
      // Release resources created by this factory, if any.
    },
  };
});
```

`onBeforeRender` runs before each Splat draw and receives the renderer, scene, camera, and Splat renderer. Use it to update uniforms, not to replace effects or start a nested render. `dispose` runs when that renderer replaces the effect or is disposed. Application-supplied textures are never disposed automatically. Shader definitions are fixed after assignment; use the factory to avoid sharing disposable resources between renderers or captures.

For a ready-made scene-light effect, see [Relighting](Relighting.md).
