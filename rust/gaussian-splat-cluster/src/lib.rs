//! Nearest SH codebook entries for `gsl-build-lod --cluster-sh`, as a
//! WebAssembly module without imports. Each point is compared with every
//! code. Distances expand to |c|² − 2x·c: |x|² is the same for all codes of
//! a point. The products use relaxed SIMD multiply-adds, which the browser
//! module must not require, so this kernel is built on its own.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
mod nearest;
