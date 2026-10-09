# Contributing

## Development setup

Requires Node.js 20.19+ or 22.12+, Rust via `rustup`, and the `wasm32-unknown-unknown` target.

```bash
npm ci
npm run build:wasm
npm run dev
```

Check WebGPU, WebGL2, and WebGPU · WebGL2 in the viewer. For rendering changes, compare sorted and stochastic rendering, mesh occlusion, and transparent edges.

See [Architecture](docs/Architecture.md) for module responsibilities, backend boundaries, and resource ownership.

Implementations and build scripts use JavaScript. Keep TypeScript declarations in adjacent `.d.ts` files and update them whenever the corresponding API changes. `src/index.js` and `src/index.d.ts` define the package's runtime and type exports.

## Validation

Before opening a pull request:

```bash
npm run release:check
```

Builds WASM, the viewer, and the package; checks JavaScript syntax, declarations, lint, tests, and npm package validation. Declaration checks use strict TypeScript consumers with Bundler and NodeNext resolution, including ESM and CommonJS package imports.

For focused validation, run `npm run check`, `npm run test:js`, and `npm run lint`. The declaration checks reject implicit exports of private declarations and compare every module's runtime value exports with its adjacent declarations; they do not infer implementation parameter or return types. `npm run build:types` copies the checked-in declarations into `dist/types`, prepares the ESM and CommonJS declaration entry points, and checks the package's type exports. Both `build:production` and `build:dev` include this step.

Review new or changed dependency install scripts and update `allowScripts` with `npm approve-scripts`.

## Pull requests

- Keep changes focused on one problem.
- Update the relevant API docs when behavior changes; keep the README focused on setup and capabilities.
- Add or update tests for behavior that can be exercised without WebGL.
- Include a small reproduction and before/after images for rendering changes where possible.
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`; leave published version sections unchanged.
- Do not commit generated `dist/`, `site-dist/`, Rust `target/`, or wasm-pack `pkg/` directories.
