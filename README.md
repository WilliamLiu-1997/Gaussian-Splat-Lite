<div align="center">

# Gaussian-Splat-Lite

[![npm version](https://img.shields.io/npm/v/gaussian-splat-lite)](https://www.npmjs.com/package/gaussian-splat-lite)
[![CI](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Three.js Gaussian Splatting · WebGPU · Depth Rendering · Streaming**

**[Try Live Demo](https://gaussian-splat-lite.vercel.app/)**

<p align="center">
  <img src="./Gaussian-Splat-Lite.svg" alt="Gaussian Splat Lite" width="1000">
</p>

</div>

Gaussian Splatting renderer for **Three.js**, with **WebGPU/WebGL2**, **depth rendering**, and **large-scene streaming**. Load PLY/SPZ/SOG/RAD models, combine them with regular 3D objects, and explore large scenes as detail loads around the camera.

## Features

| Focus | What you get |
| --- | --- |
| **WebGPU / WebGL2** | Use the same Three.js scene API with either renderer |
| **Depth Rendering** | Let Splats occlude other scene objects |
| **Large-scene streaming** | Load RAD and SOG detail as the camera moves, with smooth transitions |
| **Stochastic rendering** | Responsive camera movement with optional noise reduction |
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
  renderDepth: true, // Add Splat depth after the sorted color draw.
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

Keep the rest of the example, including `renderDepth`.

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
await streaming.initialized;

const size = new THREE.Vector2();
renderer.setAnimationLoop(() => {
  renderer.getDrawingBufferSize(size);
  streaming.update(camera, { width: size.x, height: size.y });
  renderer.render(scene, camera);
});

// The update loop must be running before awaiting the first visible data.
await streaming.firstRenderable;

// When removing the model:
// streaming.dispose();
// streaming.group.removeFromParent();
```

For streamed SOG, use this constructor and call `streaming.update(camera)` before rendering each frame; the group and readiness lifecycle are the same:

```js
import { SogStreamScheduler } from "gaussian-splat-lite";

const streaming = new SogStreamScheduler({
  url: "/assets/scene/lod-meta.json",
  splatBudget: 3_000_000,
  fadeDurationMs: 200, // Smooth LOD transitions (default).
});
```

## Depth Rendering

**`renderDepth` lets Splats occlude geometry drawn later.** Both WebGPU and WebGL2 support it.

| Setting | Default | Purpose |
| --- | --- | --- |
| `renderDepth` | `false` | Let Splats occlude geometry drawn later, including transparent meshes |
| `stochastic` | `false` | Always use stochastic rendering for responsive movement, with visible noise |
| `autoStochastic` | `false` | Use stochastic rendering during movement, then return to sorted rendering with depth |

Draw order and depth testing in other materials still matter. Stochastic rendering and transparent edges may show noise; [StochasticResolvePass](docs/GaussianSplatRenderer.md#stochastic-resolve) can reduce stochastic noise.

## Documentation

- [GaussianSplatRenderer](docs/GaussianSplatRenderer.md) — Rendering options, depth, noise reduction, captures, and XR.
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

Open the URL printed by Vite (normally `http://localhost:8080/`) and drop a `.ply`, `.spz`, `.sog`, or `.rad` file into the viewer, choose a local file, or load one from an HTTP(S) URL. For split SOG, select or drop `meta.json` together with its `.webp` images; for split RAD, include the header and its `.radc` pages. Files are decoded locally. Choose **WebGL2 / WebGPU / WebGPU · WebGL2** in the viewer to compare backends; disable automatic stochastic mode to expose the **Force Splat depth** control.

See [Contributing](CONTRIBUTING.md#validation) for validation commands. `npm run build` emits ESM, CommonJS, TypeScript declarations, and source maps in `dist/`.

## Acknowledgements

The overall architecture of Gaussian Splat Lite draws on [Spark](https://github.com/sparkjsdev/spark) and [SuperSplat](https://github.com/playcanvas/supersplat).

## License

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.md) for attribution.
