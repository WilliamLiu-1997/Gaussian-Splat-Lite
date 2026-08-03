# Gaussian Splat Lite

Gaussian Splat Lite is a focused Three.js Gaussian Splatting renderer. It keeps
the renderer shipped in Spark 2.1.0 and the supporting rendering pipeline while
removing the compatibility and large-world systems that are outside this
package's scope.

## Scope

Gaussian Splat Lite loads exactly two splat file formats:

- `.ply`
- `.spz`

The retained runtime includes `SparkRenderer`, `SplatMesh`, `SplatLoader`, the
Dyno-backed rendering pipeline, and the Rust/WebAssembly workers used for file
decoding and depth sorting. URL, in-memory byte, and standard `ReadableStream`
inputs remain available for PLY/SPZ decoding.

It intentionally does not include:

- the legacy renderer or any `Old*` renderer API;
- Level-of-Detail generation, traversal, or rendering;
- `.rad` files, virtual paged storage, or LOD page streaming;
- `.splat`, `.ksplat`, SOG/SOGS, ZIP, or other splat file formats.

## Install

```sh
npm install gaussian-splat-lite three
```

Three.js `0.180.0` or newer is required.

## Usage

```js
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "gaussian-splat-lite";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.z = 3;

const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new SparkRenderer({ renderer }));

const splats = new SplatMesh({ url: "/scene.spz" });
scene.add(splats);

renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
});
```

Use a `.ply` URL in the same way. No LoD, RAD, or paging option is needed or
supported.

## Development

Building from source requires Node.js, a Rust toolchain with `rustup`, and the
`wasm32-unknown-unknown` target. The build script installs `wasm-pack` through
Cargo when it is not already available.

```sh
npm install
npm run build
npm test
```

Run the local PLY/SPZ viewer with:

```sh
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:8080/`). Drag a
`.ply` or `.spz` file onto the viewer, or use its file picker. Files are streamed
to the local WebAssembly decoder and are not uploaded.

The package build emits ESM and CommonJS bundles in `dist/`, together with
TypeScript declarations and source maps.

## Upstream and license metadata

Gaussian Splat Lite is an independent, focused fork of
[Spark v2.1.0](https://github.com/sparkjsdev/spark/tree/v2.1.0), commit
`f22236f95fdd8078f0c12e3aab479523d401daf6`. Spark was originally developed by
[World Labs](https://www.worldlabs.ai/) and published at
[sparkjsdev/spark](https://github.com/sparkjsdev/spark).

Copyright © 2025 WORLD LABS TECHNOLOGIES, INC. The upstream license notice is
preserved in [LICENSE](LICENSE). This project is not an official Spark release
and is not endorsed by World Labs or sparkjsdev.

This fork preserves the upstream licensing metadata unchanged. See
[LICENSE](LICENSE) for the repository license and the upstream
[`rust/Cargo.toml`](https://github.com/sparkjsdev/spark/blob/v2.1.0/rust/Cargo.toml)
for the Rust workspace metadata.
