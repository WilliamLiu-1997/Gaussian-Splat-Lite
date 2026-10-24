# Contributing

## Development setup

Requires Node.js 20.19+ or 22.12+ and Rust via `rustup`. `npm run build:wasm` installs the `wasm32-unknown-unknown` target if needed.

```bash
npm ci
npm run build:wasm
npm run dev
```

Check WebGPU, WebGL2, and WebGPU · WebGL2 in the viewer. For rendering changes, compare sorted and stochastic rendering, mesh occlusion, and transparent edges.

Implementations and build scripts use JavaScript. Keep TypeScript declarations in adjacent `.d.ts` files and update them whenever the corresponding API changes. `src/index.js` and `src/index.d.ts` define the package's runtime and type exports.

### RAD command-line tool

See [Building RAD files](docs/BuildRad.md) for installation, conversion commands, and options.

Before running the CLI from a checkout, and after changing the decoder, its dependencies, or its build settings, rebuild the decoder:

```bash
npm run build:wasm:lod
```

`npm run build:wasm` also builds the CLI decoder. The generated `bin/decoder/` files are ignored by Git and included in the npm package, so npm users can run the command without compiling anything. The release workflow builds them before packaging.

## Validation

Before opening a pull request:

```bash
npm run release:check
```

Builds WASM, the viewer, and the package; checks JavaScript syntax, declarations, lint, tests, and npm package validation.

For focused validation, run `npm run check`, `npm run test:js`, and `npm run lint`. `npm run build:types` checks and packages the TypeScript declarations for ESM and CommonJS; both `build:production` and `build:dev` include this step.

Review new or changed dependency install scripts and update `allowScripts` with `npm approve-scripts`.

## Pull requests

- Keep changes focused on one problem.
- Update the relevant API docs when behavior changes; keep the README focused on setup and capabilities.
- Add or update tests for behavior that can be exercised without WebGL.
- Include a small reproduction and before/after images for rendering changes where possible.
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`; leave published version sections unchanged.
- Do not commit generated `dist/`, `site-dist/`, `bin/decoder/`, Rust `target/`, or wasm-pack `pkg/` directories.
