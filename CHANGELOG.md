# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added `SplatMesh.setSplat()`, plus `Splats.removeSplat()` and `SplatMesh.removeSplat()` for compact removal while preserving main and spherical-harmonic data alignment.
- Added `postDecode`, a serializable per-Splat expression API for transforming logical position, scale, quaternion, opacity, alpha, color, and spherical harmonics inside the decode worker, with support for external attributes.

### Changed

- Renamed the SDF blend modes to `MULTIPLY_RGBA`, `SET_RGBA`, and `ADD_RGBA`; all modes now modify only explicitly assigned color and opacity channels.
- Scaled idle decode-worker lifetime from three minutes at 64 MiB of peak WASM memory down to three seconds at 256 MiB, and preferred smaller idle workers for reuse so large workers can expire promptly.
- Generated contiguous raw sort centers during decoding and cached them in the sort worker; axial sorting now folds each mesh matrix into the view direction without materializing transformed centers, radial sorting creates transformed centers lazily, and switching modes replaces the worker and releases its previous WASM instance.

### Removed

- Removed the public `SplatSource` extension interface; `SplatMesh` now accepts only the built-in `Splats` data source.

## [0.1.3] - 2026-08-25

### Added

- Added the `SET_RGB` SDF RGBA blend mode, which replaces RGB while multiplying the existing alpha by the SDF opacity.

### Changed

- Reworked SPZ v4 decoding to process Zstandard streams incrementally with bounded buffers and to skip supported header-extension data.
- Passed logarithmic scales directly through the PLY/SPZ decode and generation pipelines, avoiding redundant exponential and logarithmic conversions.
- Deferred fetching each Splat's second texture record until its center passes view-frustum checks.
- Disposed idle decode workers after three seconds so completed loads do not retain the full worker pool.

### Fixed

- Treated `streamLength` as an exact byte count, rejecting invalid, truncated, or oversized streams before unsafe SPZ allocation.
- Validated SPZ point counts and packed renderer allocation sizes, with a default 2 GiB packed-model limit.

## [0.1.2] - 2026-08-25

### Changed

- Standardized source and accumulator records with alpha in the low float16 lane and special-kernel shape amount in the high float16 lane of the first record's final word.
- Updated TypeScript and Rust encoders to preserve raw source opacity through 1000 by storing its nonlinear LoD kernel encoding in the shape-amount lane and reconstructing the raw value for public reads.
- Removed the separate shape texture attachment and render-time texture fetch.
- Reused retired sort-center mesh IDs so Worker/WASM cache slots stay bounded by active scene churn rather than lifetime mesh count.

### Removed

- Removed `SplatAccumulator.getSplatShapeTexture()` now that generated shape data is carried by the main records.

## [0.1.1] - 2026-08-24

### Changed

- Standardized accumulator intermediates on the two-record representation, preserving camera-relative positions as 32-bit floats and color, alpha, and log-scale values as 16-bit floats.
- Kept enlarged SDF kernel shape independent from opacity and clamped generated opacity to the standard `[0, 1]` range.

### Removed

- Removed the `accumPackedSplats` option and the packed accumulator codec, shader path, and Viewer control.
- Removed the `focalDistance` and `apertureAngle` options together with the built-in depth-of-field shader path and Viewer controls.
- Removed the obsolete `LN_SCALE_MIN` and `LN_SCALE_MAX` exports that were only used by packed accumulator quantization.

## [0.1.0] - 2026-08-24

### Added

- Initial public release of the Three.js Gaussian Splatting renderer.

[Unreleased]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/788ba378ac5e3b2358313f625c4c466edd8c6fc5...v0.1.1
[0.1.0]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/releases/tag/v0.1.0
