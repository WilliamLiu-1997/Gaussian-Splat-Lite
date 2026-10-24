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

Keep binary decoder arithmetic and edge-case matrices in Rust. Use a small built-WASM suite for exported arguments, typed-array packing, and WASM32 memory behavior rather than replaying the native numerical matrix. Test manifests, transport, and scheduling at their JavaScript owners. Give each contract one primary keeper; preserve distinct security, ownership, and asynchronous-ordering checks when consolidating suites.

Review new or changed dependency install scripts and update `allowScripts` with `npm approve-scripts`.

### Private LCC export checks

Synthetic format and built-WASM checks run with `npm test`. Optional export checks read local files without copying them into the repository:

```bash
LCC_SAMPLE=/path/to/scene.lcc LCC2_SAMPLE=/path/to/scene.lcc2 \
  node --test test/lcc2Refinement.test.js test/sceneStreamSamples.test.js
PLY_SAMPLE=/path/to/source.ply SOG_SAMPLE=/path/to/export.sog \
  node --expose-gc --test test/xgridsReference.test.js
```

Each `{FILE}_SAMPLE` variable names an exact file, not a root directory. Set only the formats you want to check; unset samples are skipped. LCC/LCC2 companions resolve relative to the selected manifest. Rerun with another `LCC2_SAMPLE` to check a different payload codec. The ignored Rust numerical check also accepts `LCC_SAMPLE`.

The reference check streams a binary little-endian float-property PLY source, compares independently read source attributes and SH3, and decodes the SOG sample independently. When both `PLY_SAMPLE` and `SOG_SAMPLE` are set, they must be matching exports; the check compares their point counts and bounds. It needs the built WASM package and enough memory for one full decoded reference model. Do not redistribute private exports without permission.

## Pull requests

- Keep changes focused on one problem.
- Update the relevant API docs when behavior changes; keep the README focused on setup and capabilities.
- Add or update tests for behavior that can be exercised without WebGL.
- Include a small reproduction and before/after images for rendering changes where possible.
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`; leave published version sections unchanged.
- Do not commit generated `dist/`, `site-dist/`, `bin/decoder/`, Rust `target/`, or wasm-pack `pkg/` directories.
