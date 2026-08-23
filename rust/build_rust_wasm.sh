#!/usr/bin/env bash

set -euo pipefail

RUST_DIR="$(cd "$(dirname "$0")" && pwd)"
WASM_PACK_VERSION="0.15.0"

if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
    echo "Rust tools 'rustc' and 'cargo' are required to build the WebAssembly packages."
    echo "Install Rust from https://www.rust-lang.org/tools/install"
    exit 1
fi

WASM_TARGET="$(rustc --print sysroot 2>/dev/null)/lib/rustlib/wasm32-unknown-unknown"

if ! [ -d "$WASM_TARGET" ] && ! command -v rustup >/dev/null 2>&1; then
    echo "Rust tool 'rustup' not found! Please install Rust to build."
    echo "Visit https://www.rust-lang.org/tools/install"
    exit 1
fi

if ! [ -d "$WASM_TARGET" ]; then
    rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
    cargo install wasm-pack --version "$WASM_PACK_VERSION" --locked
fi

# Build Cargo artifacts and wasm-pack output on the system temporary volume.
# Some external macOS volumes create AppleDouble `._*.wasm` sidecars while
# wasm-pack is still optimizing output, which makes wasm-bindgen or wasm-opt
# mistake a sidecar for a WebAssembly module.
WASM_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gaussian-splat-lite-wasm.XXXXXX")"
cleanup() {
    rm -rf "$WASM_BUILD_DIR"
}
trap cleanup EXIT

build_package() {
    local package_name="$1"
    local source_dir="$RUST_DIR/$package_name"
    local build_dir="$WASM_BUILD_DIR/$package_name"
    local output_dir="$source_dir/pkg"

    (
        cd "$source_dir"
        CARGO_TARGET_DIR="$WASM_BUILD_DIR/cargo-target" \
            RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" \
            wasm-pack build --target web --release --out-dir "$build_dir" -- --locked
    )

    rm -rf "$output_dir"
    mkdir -p "$output_dir"
    COPYFILE_DISABLE=1 cp -R "$build_dir/." "$output_dir/"
    find "$output_dir" -maxdepth 1 -name '._*' -delete
}

build_package "gaussian-splat-rs"
