# Contributing

Thanks for contributing to `gaussian-splat-lite`.

## Development setup

Building the WebAssembly module requires Node.js 20.9 or newer, a Rust
toolchain installed through `rustup`, and the `wasm32-unknown-unknown` target.

```bash
npm ci
npm run build:wasm
```

Start the local viewer with `npm run dev`.

## Validation

Run the complete release check before opening a pull request:

```bash
npm run release:check
```

This builds the WebAssembly module and example site, type-checks and lints the
source, runs the tests, builds the package, and verifies the npm tarball.

When dependency updates introduce or change install scripts, review them and
update the pinned `allowScripts` entries with `npm approve-scripts`.

## Pull requests

- Keep changes focused on one problem.
- Update the README and API docs when public behavior changes.
- Add or update tests for behavior that can be exercised without WebGL.
- Include a minimal reproduction and captures for rendering changes when
  possible.
- Add user-visible changes to the `Unreleased` section of `CHANGELOG.md`.
- Do not commit generated `dist/`, `site-dist/`, Rust `target/`, or wasm-pack
  `pkg/` directories.

## Maintainer releases

The npm package is published by `.github/workflows/publish.yml` when a matching
`v*` tag is pushed. The workflow rejects tags that do not match the version in
`package.json`, skips versions already present on npm, and creates the GitHub
release from `CHANGELOG.md`.

Before the first automated release, make the GitHub repository public, then
publish the package once from a maintainer account so that its npm settings
exist:

```bash
npm run release:check
npm publish --access public
```

Then, using a current npm CLI, configure GitHub Actions as the trusted publisher
for future releases:

```bash
npm trust github gaussian-splat-lite \
  --repo WilliamLiu-1997/Gaussian-Splat-Lite \
  --file publish.yml \
  --allow-publish
```

The same setting is available under the package's npm **Settings → Trusted
Publisher** page. The workflow uses short-lived OIDC credentials, so no
`NPM_TOKEN` repository secret is required after this setup.

For each release:

1. Move the relevant changelog entries from `Unreleased` into a dated version
   section.
2. Update `package.json` and `package-lock.json` with
   `npm version <version> --no-git-tag-version`.
3. Run `npm run release:check`, commit the release changes, then create and push
   `v<version>`.
