# gaussian-splat-rs

Support package included in Gaussian Splat Lite. Application users do not need
to build it separately.

For local development, build it from the repository root:

```sh
npm run build:wasm
```

The build requires `rustup` and the `wasm32-unknown-unknown` target. The build
script installs `wasm-pack` with Cargo when it is not already available and
writes generated package files to `rust/gaussian-splat-rs/pkg/`.
