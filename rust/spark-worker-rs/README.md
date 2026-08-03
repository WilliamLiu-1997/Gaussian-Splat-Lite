# spark-worker-rs

Rust/WebAssembly support for Gaussian Splat Lite. This worker package contains
the PLY/SPZ decoders and 32-bit depth sorter used by the browser bundle.

From the repository root, build both WebAssembly packages with:

```sh
npm run build:wasm
```

The build requires `rustup` and the `wasm32-unknown-unknown` target. The build
script installs `wasm-pack` with Cargo when it is not already available and
writes generated package files to `rust/spark-worker-rs/pkg/`.
