<div align="center">

# Gaussian-Splat-Lite

[![npm version](https://img.shields.io/npm/v/gaussian-splat-lite)](https://www.npmjs.com/package/gaussian-splat-lite)
[![CI](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Three.js Gaussian Splatting · WebGPU · Streaming**

Gaussian Splatting renderer for **Three.js**, with **WebGPU/WebGL2** and **large-scene streaming**. Load PLY/SPZ/SOG/RAD models, combine them with regular 3D objects, and explore large scenes as detail loads around the camera.

<div align="center">

**[Try Live Demo](https://gaussian-splat-lite.vercel.app/)**

</div>

<p align="center">
  <a href="https://gaussian-splat-lite.vercel.app/">
    <img src="./.github/assets/default-demo.gif" alt="Gaussian Splat Lite — default example with a seamless 90-degree camera orbit" width="800">
  </a>
</p>

</div>

## Features

| Focus | What you get |
| --- | --- |
| **WebGPU / WebGL2** | Use the same Three.js scene API with either renderer |
| **Stochastic rendering** | Optional transparency mode for use with temporal anti-aliasing |
| **Large-scene streaming** | Load RAD and SOG detail as the camera moves, with smooth transitions |
| **SDF edits** | Recolor or hide parts of a model without moving Splats |
| **Data and precision** | Load URLs, files, or bytes; place local models in large GIS/ECEF scenes |

## Installation

```sh
npm install gaussian-splat-lite three
```

Requires Three.js `>=0.186.0`.

## Quick start

`SplatMesh` is a scene object. Add one `GaussianSplatRenderer` to display all visible Splat models in the scene.

### WebGPU

```js
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";

const renderer = new WebGPURenderer({ antialias: false });
await renderer.init(); // Initialize before constructing GaussianSplatRenderer.
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 1000,
);
camera.position.set(0, 0, 3);

const splatRenderer = new GaussianSplatRenderer({
  renderer,
});
scene.add(splatRenderer);

const splat = new SplatMesh({ url: "/assets/scene.spz" });
scene.add(splat);
await splat.initialized;

renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
```

### WebGL2

`WebGPURenderer` automatically falls back to its WebGL2 backend when WebGPU is unavailable. To choose WebGL2 explicitly:

```js
const renderer = new WebGPURenderer({ antialias: false, forceWebGL: true });
await renderer.init();
```

For the classic WebGL renderer, replace the WebGPU renderer creation and initialization with:

```js
const renderer = new THREE.WebGLRenderer({ antialias: false });
```

Keep the rest of the example unchanged.

## Stochastic rendering

Sorted alpha blending is the default. To enable stochastic rendering:

```js
splatRenderer.stochastic = true;
```

This mode produces visible noise. Use the library's [TAAPass](docs/TAAPass.md) with `WebGLRenderer`, or Three.js `TRAANode` with `WebGPURenderer` (including its WebGL2 fallback), to smooth it. See [Stochastic rendering](docs/StochasticRendering.md) for sorting options and TAA setup.

## Streaming large scenes

Use `RadStreamScheduler` for RAD scenes with levels of detail (LOD), or `SogStreamScheduler` for SOG `lod-meta.json` scenes. Both load detail as the camera moves and work on WebGPU and WebGL2.

For RAD, replace the `SplatMesh` loading and animation loop in the quick start with:

```js
import { RadStreamScheduler } from "gaussian-splat-lite";

const streaming = new RadStreamScheduler({
  url: "/assets/scene.rad",
  splatBudget: 3_000_000,
  fadeDurationMs: 200, // Smooth LOD transitions (default).
});
scene.add(streaming.group);
streaming.setCamera(camera);
streaming.setResolutionFromRenderer(camera, renderer); // CSS pixels; again after resizing.
await streaming.initialized;

renderer.setAnimationLoop(() => {
  streaming.update();
  renderer.render(scene, camera);
});

// The update loop must be running before awaiting the first visible data.
await streaming.firstRenderable;

// When removing the model:
// streaming.dispose();
// streaming.group.removeFromParent();
```

For streamed SOG, use this constructor. Register the camera with `setCamera(camera)` and call `streaming.update()` before rendering each frame; SOG detail follows distance, so it needs no resolution. The group and readiness lifecycle are the same:

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler({
  url: "/assets/scene/lod-meta.json",
  splatBudget: 3_000_000,
  fadeDurationMs: 200, // Smooth LOD transitions (default).
});
```

## Documentation

- [GaussianSplatRenderer](docs/GaussianSplatRenderer.md) — Rendering options and sorting.
- [Stochastic rendering](docs/StochasticRendering.md) — Optional rendering mode, noise control, and temporal anti-aliasing.
- [TAAPass](docs/TAAPass.md) — Temporal reprojection for WebGLRenderer without a velocity texture.
- [SplatMesh](docs/SplatMesh.md) — Loading, transforms, animation, and raycasting.
- [SplatLoader](docs/SplatLoader.md) — File loading.
- [RadStreamScheduler](docs/RadStreamScheduler.md) — Large RAD scenes with adaptive detail.
- [SogStreamScheduler](docs/SogStreamScheduler.md) — Large SOG scenes with adaptive detail.
- [Splats](docs/Splats.md) — Data access and updates.
- [SplatFileType](docs/SplatFileType.md) — PLY/SPZ/SOG/RAD formats.
- [SplatEdit / SplatEditSdf](docs/SplatEdit.md) — Color and opacity editing.
- [postDecode](docs/PostDecode.md) — Transform models while loading.
- [SplatAccumulator](docs/SplatAccumulator.md) — Combined model data for custom integrations.

## Development

Requires Node.js 20.9+, Rust via `rustup`, and the `wasm32-unknown-unknown` target. `build:wasm` installs `wasm-pack` through Cargo if needed.

```sh
npm ci
npm run build:wasm
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:8080/`) and drop a `.ply`, `.spz`, `.sog`, or `.rad` file into the viewer, choose a local file, or load one from an HTTP(S) URL. For split SOG, select or drop `meta.json` together with its `.webp` images; for split RAD, include the header and its `.radc` pages. Files are decoded locally. Choose **WebGPU / WebGL2 / WebGPU · WebGL2** in the viewer to compare backends.

See [Contributing](CONTRIBUTING.md#validation) for validation commands. `npm run build` emits ESM, CommonJS, TypeScript declarations, and source maps in `dist/`.

## Acknowledgements

The overall architecture of Gaussian Splat Lite draws on [Spark](https://github.com/sparkjsdev/spark) and [SuperSplat](https://github.com/playcanvas/supersplat).

Example model adapted from [shehabmekky](https://superspl.at/scene/c1e6297e) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).

## License

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.md) for attribution.
