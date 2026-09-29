# Lighting and shadows (experimental)

Lighting is opt-in and supports independent WebGL, native WebGPU, and WebGPURenderer's WebGL backend.

```js
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // Or BasicShadowMap.

const splatRenderer = new GaussianSplatRenderer({ renderer, lighting: true });
const model = new SplatMesh({
  url: "model.spz",
  receiveLight: true,
  castShadow: true,
  receiveShadow: true,
});
const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0001;
sun.shadow.normalBias = 0.02;
// Fit sun.shadow.camera to your scene, as with ordinary Three.js shadows.
scene.add(splatRenderer, model, sun, sun.target);
await model.initialized;
renderer.render(scene, camera);
```

`lighting` defaults to `false`, `receiveLight` to `true`, and both model shadow flags to `false`. These are mutable properties. `receiveLight = false` preserves model color and bypasses shadow reception. `splatRenderer.filter = mesh => selected.has(mesh)` selects models for both color and shadows. Meshes use their normal Three.js `castShadow` and `receiveShadow` controls. Initialize WebGPURenderer before constructing GaussianSplatRenderer.

AmbientLight, HemisphereLight, DirectionalLight, PointLight, and SpotLight use Lambert diffuse response and Three.js light colors, intensities, attenuation, targets, and spot cones. Model colors remain the reflectance basis, including existing SH color. A white AmbientLight with intensity `Math.PI` gives unit Lambert illumination. Captured model color can already contain lighting; this does not recover intrinsic albedo or authored normals.

Lighting uses linear RGB on every backend and converts the result to the active blending color space. Three.js light colors must represent linear RGB; when using an sRGB working space for splat blending, the viewer explicitly linearizes its light colors while keeping the visible light helpers in the working space.

Normals and receiving surfaces are estimated from each Gaussian's shape. Large or grazing Gaussians can show shading inaccuracies.

Gaussian shadows use a **Popless covariance depth plane** computed in the vertex shader, preserving continuously varying depth across each Gaussian. Shadow opacity includes model opacity and SDF edits. Logarithmic depth is supported.

Transparent edges use stable stochastic coverage, independent of main-pass temporal noise. Basic shadows may show grain; PCF filters the coverage. Popless does not eliminate all artifacts from approximate Gaussian surfaces or point-light face boundaries.

Three.js manages shadow maps, filtering, and update settings. Each point light requires six shadow views. Casters reuse source textures without shadow sorting or per-light projection caches, and skip blocks outside each light view. Lighting still adds per-fragment shading, shadow rendering, and storage costs; native WebGPU uses an additional 24 bytes per projected slot when lighting is enabled.

Enabling lighting does not change `renderDepth`, `depthWrite`, stochastic settings, or TAA configuration. Streamed scenes, XR, and all combinations of these options have not been fully validated.

## Viewer controls

Run `npm run dev` and open **Render options → Lighting & shadows** for the three orbiting red, green, and blue point lights:

- **Point lights** turns lighting on or off.
- **Rotate lights** pauses or resumes their motion.
- **Cast / receive shadows** controls the lights' shadows; Gaussian casters use Popless depth.
- **Ambient brightness** and **Light intensity** adjust the illumination.

The viewer enables lights, motion, and shadows by default, with ambient brightness `0.35`, light intensity `0.8`, and 256 × 256 PCF maps per point-light face. Light positions and ranges follow the loaded model's framing. Settings survive renderer-backend switches and return to these defaults with Reset. The library's own `lighting` default remains `false`.
