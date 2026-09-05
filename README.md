<div align="center">

# Gaussian-Splat-Lite

[![npm version](https://img.shields.io/npm/v/gaussian-splat-lite)](https://www.npmjs.com/package/gaussian-splat-lite)
[![CI](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Three.js Gaussian Splatting · WebGPU · Depth Rendering**

<p align="center">
  <img src="./Gaussian-Splat-Lite.svg" alt="Gaussian Splat Lite" width="1000">
</p>

</div>

A lightweight 3D Gaussian Splatting renderer for Three.js, with **WebGPU**, **depth rendering for scene occlusion**, and WebGL2 support. Load PLY/SPZ files into standard Three.js scenes and render multiple Splat objects together. Based on a simplified [SparkJS](https://github.com/sparkjsdev/spark) architecture.

## Features

| Focus | What you get |
| --- | --- |
| **WebGPU / WebGL2** | Shared scene API and Worker/WASM sorting; WebGPU adds TSL shaders, compute-based generation, and optional GPU radix sorting |
| **Depth Rendering** | Dedicated front-to-back depth draw with stochastic coverage at transparent edges |
| **Stochastic rendering** | Sorting-free rendering for responsive camera movement, with optional spatial resolve to reduce noise |
| **Three.js integration** | Standard scenes, cameras, transforms, raycasting, and global sorting across multiple `SplatMesh` objects |
| **Data and precision** | PLY/SPZ from URLs, bytes, or streams; camera-relative rendering for large GIS/ECEF coordinates |

Also includes spherical harmonics, SDF edits, offscreen capture, and TypeScript declarations.

## Installation

```sh
npm install gaussian-splat-lite github:mrdoob/three.js#d2fc542d58f5c91fa7b585e6a3efb7ba67b295ca
```

Use the pinned Three.js snapshot above: the WebGPU compatibility patches depend on its built modules. The browser must support the selected graphics backend, WebAssembly, Web Workers, and ES modules. Cross-origin Splat URLs need CORS headers.

The [changelog](CHANGELOG.md#unreleased) currently lists WebGPU and the new depth options under **Unreleased**. To try the implementation in this checkout, follow [Development](#development).

## Quick start

`SplatMesh` is a scene object. One `GaussianSplatRenderer` handles generation, sorting, and drawing for all visible Splat objects.

### WebGPU

```js
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";

const renderer = new WebGPURenderer({ antialias: false });
await renderer.init(); // Initialize before constructing GaussianSplatRenderer.
if (renderer.backend.isWebGPUBackend !== true) {
  throw new Error("WebGPU is required for this example");
}
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

Replace the WebGPU renderer creation, initialization, and backend check with:

```js
const renderer = new THREE.WebGLRenderer({ antialias: false });
```

Keep the rest of the example, including `renderDepth`.

## Depth Rendering

**`renderDepth` adds a dedicated depth draw while keeping sorted color blending.** Both WebGPU and WebGL2 support it.

| Setting | Default | Purpose |
| --- | --- | --- |
| `renderDepth` | `false` | Adds Splat depth for geometry drawn later, including transparent meshes |
| `stochastic` | `false` | Forces sorting-free stochastic rendering with direct depth writes |
| `autoStochastic` | `false` | Uses stochastic rendering during motion and enables companion depth on sorted frames |

With default depth settings, the companion draw runs on non-stochastic frames, traverses the existing order near to far, and samples alpha coverage so transparent edges do not become solid. Stochastic frames already write their own depth.

## Documentation

- [GaussianSplatRenderer](docs/GaussianSplatRenderer.md) — Rendering, sorting, depth, resolve, and XR.
- [SplatMesh](docs/SplatMesh.md) — Loading, transforms, animation, and raycasting.
- [SplatLoader](docs/SplatLoader.md) — File loading.
- [Splats](docs/Splats.md) — Data access and updates.
- [SplatFileType](docs/SplatFileType.md) — PLY/SPZ formats.
- [SplatEdit / SplatEditSdf](docs/SplatEdit.md) — Color and opacity editing.
- [postDecode](docs/PostDecode.md) — Experimental decode transformations.
- [SplatAccumulator](docs/SplatAccumulator.md) — Low-level GPU buffers.

## Development

Requires Node.js 20.9+, Rust via `rustup`, and the `wasm32-unknown-unknown` target. `build:wasm` installs `wasm-pack` through Cargo if needed.

```sh
npm ci
npm run build:wasm
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:8080/`) and drop a `.ply` or `.spz` file into the viewer. Files are decoded locally. Switch **WebGL / WebGPU** in the viewer to compare backends; disable automatic stochastic mode to expose the **Force Splat depth** control.

See [Contributing](CONTRIBUTING.md#validation) for validation and release commands. `npm run build` emits ESM, CommonJS, TypeScript declarations, and source maps in `dist/`.

## License

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.md) for attribution.
