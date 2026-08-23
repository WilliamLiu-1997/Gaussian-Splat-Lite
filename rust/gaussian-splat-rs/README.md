# gaussian-splat-rs

Rust/WebAssembly support for Gaussian Splat Lite. This package contains the
PLY/SPZ decoders, 32-bit depth sorter, and raycaster used by the browser bundle.

From the repository root, build the WebAssembly package with:

```sh
npm run build:wasm
```

The build requires `rustup` and the `wasm32-unknown-unknown` target. The build
script installs `wasm-pack` with Cargo when it is not already available and
writes generated package files to `rust/gaussian-splat-rs/pkg/`.
