# Splat shader modifiers

Attach a modifier to one mesh with `mesh.setWorkBufferModifier(options)` or to every splat drawn by one renderer with `splatRenderer.setRenderModifier(options)`. The mesh hook runs first. Both use **absolute world coordinates**. Pass `null` to either setter to remove its modifier.

This example uses the original world-space height to animate a reveal. The GLSL and WGSL strings are function bodies. GSL supplies the parameters and collects the modified fields.

```js
const reveal = splatRenderer.setRenderModifier({
  uniforms: { front: { type: "float", value: 0 } },
  glsl: `
    float k = smoothstep(-0.1, 0.1, front - originalCenter.y);
    scale *= mix(0.19, 1.0, k);
    color.a *= k;
  `,
  wgsl: `
    let k = smoothstep(-0.1, 0.1, front - originalCenter.y);
    scale *= mix(0.19, 1.0, k);
    color.a *= k;
  `,
});

reveal.setUniform("front", 1.5);
```

| Field | Meaning |
| --- | --- |
| `center` | Writable absolute world-space center. The render hook sees the position produced by the mesh hook. |
| `originalCenter` | Read-only absolute world-space center before either hook, including the mesh transform. |
| `scale` | Three linear splat-axis sizes in world units. Multiply all three by one value for uniform scaling. |
| `rotation` | World-space quaternion in XYZW order. Supply a nonzero quaternion. |
| `color` | RGB and opacity in the alpha channel. The mesh hook sees SH and SDF edits before mesh recolor, opacity and LOD fading. The render hook receives the resulting RGB and draw alpha. |
| `seed` | Read-only unsigned integer based on mesh identity and the source splat index. It stays stable across reordering. Different LOD representations can have different seeds. |

Classic `WebGLRenderer` uses `glsl`. Both `WebGPURenderer` backends prefer `tsl` when supplied. Otherwise the WebGL2 fallback uses `glsl` and native WebGPU uses `wgsl`. A TSL callback receives writable nodes and a dictionary of uniform nodes. For example, add this implementation alongside a GLSL implementation to cover all three backends:

```js
import { mix, smoothstep } from "three/tsl";

const tsl = ({ originalCenter, scale, color }, { front }) => {
  const k = smoothstep(-0.1, 0.1, front.sub(originalCenter.y));
  scale.mulAssign(mix(0.19, 1.0, k));
  color.a.mulAssign(k);
};
```

Uniforms support `float`, `int`, `uint`, `bool`, `vec2`–`vec4`, `mat3` and `mat4`. Use Three.js vectors and matrices for the corresponding types. Pass the new value to the returned binding's `setUniform(name, value)`, including after mutating a vector in place. Each binding owns its parameter values. Uniform updates reuse the shader program.

On WebGL2, a mesh parameter change refreshes that mesh's accumulator range. A render parameter change only updates draw uniforms. The render hook can read the original center and seed from an extra RGBA32UI stream (16 bytes per allocated splat, replacing the seed-only stream in stochastic mode). Direct GLSL references enable it automatically. Set `sourceData: true` if a macro constructs either name. TSL defaults to enabling this stream; set `sourceData: false` for effects that use neither field.

On native WebGPU the two hooks execute in the existing projection compute pass. GPU sorting uses the modified center. The WebGL2 worker continues sorting the CPU source centers. Shader changes affect rendering; CPU raycasts, bounds and streaming selection use the source geometry.

Absolute shader coordinates have float32 precision. At a world-axis value of 6,400,000, adjacent representable values are 0.5 units apart. GSL retains its camera-relative projection internally and applies the change in world position, so a color-only hook preserves center precision.
