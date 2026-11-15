# C WebAssembly modules

Requires Git and Python 3 with `venv` support. Build from the repository root:

- `npm run build:wasm:lod` builds the Rust CLI modules and WebP encoder.
- `npm run build:wasm` also links the WebP decoder into the Rust browser WASM module.

The script installs Emscripten 4.0.23 and isolated CMake 3.31.6/Ninja 1.11.1.4
tools as needed, caching tools and sources under
`~/.cache/gaussian-splat-lite/c/`. Compilation uses a temporary directory on
the system volume. npm users receive the built modules and need no compiler.

Each module has its own subdirectory and is added to `CMakeLists.txt`.
Add its build targets as dependencies of the `wasm` build target. Generated
files in the build's `modules/` directory are copied to the Git-ignored
`bin/decoder/` directory.

## WebP

`webp/` builds libwebp 1.6.0 from the official source archive, verified by
SHA-256. The SOG CLI uses lossless preset 1 with `exact=1` to preserve every
RGBA byte, including RGB under zero alpha.

The encoder generates `bin/decoder/webp.mjs` and `bin/decoder/webp.wasm`.
The decoder accepts only static lossless WebP and writes directly into
Rust-owned pixel buffers. Rust handles ZIP validation and SOG properties.

The build uses `-msimd128` for compiler auto-vectorization. libwebp's
explicit SIMD is disabled because its AVX2 selection fails to compile with
emsdk 4.0.23.

Separate CMake build directories keep the encoder's LTO and Emscripten
allocator apart from the decoder's `-fno-lto` and Rust allocator routing.
Both builds share the same verified source archive.

After `npm run build:wasm`, run `npm run check:webp` to verify lossless
RGB/RGBA encoding and SOG decoding, including RGB under zero alpha.
`npm run release:check` includes this check. Rust CI additionally checks
decoder linking with Rust 1.87, using the WASM target flags in
`rust/.cargo/config.toml`.

Source: [libwebp](https://chromium.googlesource.com/webm/libwebp/+/refs/tags/v1.6.0).
See the repository's `THIRD_PARTY_LICENSES.md` for license notices.
