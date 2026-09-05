# Contributing

## Development setup

Requires Node.js 20.9+, Rust via `rustup`, and the `wasm32-unknown-unknown` target.

```bash
npm ci
npm run build:wasm
npm run dev
```

Check both WebGL and WebGPU in the viewer. For depth changes, compare mesh occlusion and transparent edges; disable **Automatic stochastic** to expose **Force Splat depth**.

See [Source architecture](docs/Architecture.md) for module responsibilities and backend boundaries.

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
- Include a minimal reproduction and captures for rendering changes where possible.
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`.
- Do not commit generated `dist/`, `site-dist/`, Rust `target/`, or wasm-pack `pkg/` directories.

## Maintainer releases

Pushing a `v*` tag runs `.github/workflows/publish.yml`. It requires a matching `package.json` version, skips existing npm versions, and creates the GitHub release from `CHANGELOG.md`.

Before the first automated release, make the repository public and publish once from a maintainer account:

```bash
npm run release:check
npm publish --access public
```

Configure GitHub Actions as the trusted publisher with a current npm CLI:

```bash
npm trust github gaussian-splat-lite \
  --repo WilliamLiu-1997/Gaussian-Splat-Lite \
  --file publish.yml \
  --allow-publish
```

Alternatively, use npm **Settings → Trusted Publisher**. The workflow uses OIDC; no `NPM_TOKEN` secret is needed.

For each release:

1. Move `Unreleased` entries into a dated version section.
2. Run `npm version <version> --no-git-tag-version` to update both package files.
3. Run `npm run release:check`, commit, then create and push `v<version>`.
