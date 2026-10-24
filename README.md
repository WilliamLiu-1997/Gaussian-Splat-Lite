<div align="center">

# Gaussian-Splat-Lite

[![npm version](https://img.shields.io/npm/v/gaussian-splat-lite)](https://www.npmjs.com/package/gaussian-splat-lite)
[![CI](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml/badge.svg)](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Three.js Gaussian Splatting · WebGPU · Streaming**

High performance 3D Gaussian Splatting (3DGS) renderer for **Three.js** with **WebGPU**/**WebGL2**. Supports PLY, SPZ, Streaming LOD including SOG and RAD.

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
| **Large-scene streaming** | Load RAD and SOG detail as the camera moves, with smooth transitions |
| **Stochastic rendering** | Optional transparency mode, with an experimental neural denoiser to smooth it |
| **Offscreen capture** | Render Splats to images, cube maps, and environment maps for reflections |
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

## LCC and LCC2 scenes

Use `LccStreamScheduler({ url: "/scene/model.lcc" })` or `Lcc2StreamScheduler({ url: "/scene/model.lcc2" })` with the streaming lifecycle below: add `group`, register a camera, call `update()` each frame, and await `initialized` / `firstRenderable`. These are scene APIs, not `SplatFileType` values. In the viewer, drop the complete export folder or enter the manifest URL.

- LCC supports `5.0` / `COMPRESS`, explicit Portable or Quality profiles, checked binary ranges, SH3, and optional environment splats. It chooses one alternative per XY Unit, loads coarse data first, and switches atomically. Conservative scene-wide bounds prevent cross-cell records from being culled; culling and distance scores are scene-wide rather than per-Unit. Lowercase and documented capitalized companion names are recognized; `companionPaths` supplies other exact paths. Use `fileType: "Portable"` or `"Quality"` only as an explicit compatibility override for a missing manifest field. Non-identity global transforms are rejected because their composition is not documented.
- LCC2 supports the `0.0.3` replacement profile with PLY, SPZ, or SOG payloads. It verifies payload-level totals against `lodSplats`, loads coarse coverage first, and atomically replaces a parent only after its complete selected child cut is ready. Shared files decode once while cached; unused decoded sources remain reusable for two seconds and can be evicted sooner under memory pressure. Ranges retain file-relative picking IDs, and exposed resource versions are checked across reloads. Use `refinement: "leaves"` for spatial leaf streaming without replacement-profile validation. Array-valued node data and virtual LOD generation are not supported.
- Both use `splatBudget` (default `3_000_000`, including the environment), `manager`, request settings, `onChange`, and `onError`. `lodDistances` sets descending coarse-to-fine distance thresholds; omit it to refine within the point budget. `lodHysteresis` defaults to `0.15`. `stats` reports visible data, actual resident SH degree, failed representations (`failedNodes`), decoded cache bytes (`cachedBytes`), and binary-buffer reservations. `pendingBytes` includes pending source CPU and unpublished batch CPU/GPU reservations. Small node ranges share render batches. Replacement scenes reserve their complete coarse layout while any part is selected, so camera changes cannot fragment or exhaust promised coverage; these hidden slots count toward resident memory, not visible splats. Picking metadata is in `hit.sceneStream`, with the Unit, node, resource URL, and file-relative range start; `hit.sourceIndex` remains file-relative. Batch-level range metadata is available in `hit.object.userData.sceneStream.regions`, keyed by backing-storage slot.
- `maxResidentCpuBytes` defaults to **2 GiB** and `maxResidentGpuBytes` to **1 GiB**, matching RAD. Admission includes encoded inputs, source arrays, decoder work, capped WASM capacity, region copies, and old/new batch overlap. A larger actual payload header requires a new reservation before output allocation. Impossible minimum budgets fail explicitly; failed upgrades retain existing coverage. These limits cover owned binary buffers, not total browser memory, JS object overhead, or renderer-owned buffers.
- Scene-source limits are 8 million records and 768 MiB encoded data per LCC representation/environment or LCC2 storage file. Large LCC representations use blocks of at most 262,144 records; old coverage stays visible until the complete replacement is ready. Compressed LCC2 files decode whole, while multi-file cuts extract and release one source at a time. These limits do not cap the total LCC storage-file size or the ordinary streaming PLY loader. Remote LCC storage requires byte-range support; CORS deployments must expose Content-Range totals or provide file sizes for environment discovery.
- Scene APIs keep source coordinates. The viewer's Auto axis choice uses Z-up for these scenes; use its axis selector if needed. Orientation, anisotropy, and SH still require comparison with reference views. No EPSG reprojection, collision meshes, BVH, extra attributes, or writing support is claimed.

Data Organization Format originated from XGRIDS. See the [LCC](https://github.com/xgrids/LCCWhitepaper/blob/b38c2eb31be24e4220f23c69c4a0f3306356920e/README.md) and [LCC2](https://github.com/xgrids/LCC2Whitepaper/blob/039367dbe53ccbfa07b44a8e6280ceb4ebf8aa0b/README.md) whitepapers for format terms. Maintainer review of these terms and comparison with authoritative reference views remain release gates. These APIs target native splat viewing and streaming; ancillary meshes, collision/BVH queries, extra attributes, virtual LOD generation, and writing remain separate features.

## Stochastic rendering

Sorted alpha blending is the default. To enable stochastic rendering:

```js
splatRenderer.stochastic = true;
```

This mode produces visible noise. Smooth it with the [experimental neural denoiser](docs/NeuralDenoiseNode.md), which supports WebGPU and WebGL2, including WebXR. See [Stochastic rendering](docs/StochasticRendering.md) for setup and requirements.

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

**Rendering**

- [GaussianSplatRenderer](docs/GaussianSplatRenderer.md) — Rendering options, sorting, and on-demand rendering.
- [Stochastic rendering](docs/StochasticRendering.md) — The optional transparency mode and how to smooth its noise.
- [Neural denoising (Experimental)](docs/NeuralDenoiseNode.md) — Neural denoising on WebGPU and WebGL2, including per-eye WebXR rendering with `NeuralDenoiseXR`.
- [SplatCapture](docs/SplatCapture.md) — Offscreen images, pixel readback, cube maps, and environment maps.

**Models**

- [SplatMesh](docs/SplatMesh.md) — Loading, transforms, animation, and picking.
- [SplatLoader](docs/SplatLoader.md) — Three.js-style loading, progress, cancellation, and split files.
- [SplatFileType](docs/SplatFileType.md) — PLY, SPZ, SOG, and RAD formats.
- [postDecode](docs/PostDecode.md) — Change Splats while a model loads.
- [SplatEdit and SplatEditSdf](docs/SplatEdit.md) — Recolor, fade, or hide parts of a model.
- [Splats](docs/Splats.md) — Read a loaded model's data.

**Large scenes**

- [Building RAD files](docs/BuildRad.md) — Convert models to streamable RAD with quality LOD.
- [RadStreamScheduler](docs/RadStreamScheduler.md) — Large RAD scenes with adaptive detail.
- [SogStreamScheduler](docs/SogStreamScheduler.md) — Large SOG scenes with adaptive detail.

## Development

Requires Node.js 20.19+ or 22.12+, Rust via `rustup`, and the `wasm32-unknown-unknown` target. `build:wasm` installs `wasm-pack` through Cargo if needed.

```sh
npm ci
npm run build:wasm
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:8080/`) and drop a `.ply`, `.spz`, `.sog`, or `.rad` file into the viewer, choose a local file, or load one from an HTTP(S) URL. For split SOG, select or drop `meta.json` together with its `.webp` images; for split RAD, include the header and its `.radc` pages. Files are decoded locally. Choose **WebGPU / WebGL2 / WebGPU · WebGL2** in the viewer to compare backends.

See [Contributing](CONTRIBUTING.md#validation) for validation commands. `npm run build` emits ESM, CommonJS, declarations, and source maps in `dist/`.

## Acknowledgements

Gaussian Splat Lite uses [Spark](https://github.com/sparkjsdev/spark) and [SuperSplat](https://github.com/playcanvas/supersplat) as reference implementations.

## License

Licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.md) for attribution.
