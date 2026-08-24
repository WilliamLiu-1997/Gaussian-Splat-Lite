# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/compare/788ba378ac5e3b2358313f625c4c466edd8c6fc5...v0.1.1
[0.1.0]: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/releases/tag/v0.1.0
