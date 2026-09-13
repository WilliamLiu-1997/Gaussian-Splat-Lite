# Contributing

## Development setup

Requires Node.js 20.9+, Rust via `rustup`, and the `wasm32-unknown-unknown` target.

```bash
npm ci
npm run build:wasm
npm run dev
```

Check WebGL2, WebGPU, and WebGPU · WebGL2 in the viewer. For depth changes, compare mesh occlusion and transparent edges; disable **Automatic stochastic** to expose **Force Splat depth**.

See [Architecture](docs/Architecture.md) for module responsibilities, backend boundaries, and resource ownership.

## Validation

Before opening a pull request:

```bash
npm run release:check
```

Builds WASM, the viewer, and the package; runs type checks, lint, tests, and npm package validation.

Review new or changed dependency install scripts and update `allowScripts` with `npm approve-scripts`.

## Pull requests

- Keep changes focused on one problem.
- Update the relevant API docs when behavior changes; keep the README focused on setup and capabilities.
- Add or update tests for behavior that can be exercised without WebGL.
- Include a small reproduction and before/after images for rendering changes where possible.
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`; leave published version sections unchanged.
- Do not commit generated `dist/`, `site-dist/`, Rust `target/`, or wasm-pack `pkg/` directories.
