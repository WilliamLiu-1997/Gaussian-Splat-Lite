import { copyFile } from "node:fs/promises";
import { build } from "esbuild";
import { converterAliases } from "./converter-aliases.js";

// Keep native module Worker and WASM URLs visible to downstream bundlers.
const outdir = "dist/converter";
await build({
  entryPoints: ["index", "worker", "task", "disk-worker"].map(
    (name) => `converter/${name}.js`,
  ),
  outdir,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  alias: { ...converterAliases, module: "@jspm/core/nodelibs/module" },
  define: { "globalThis.process": "undefined" },
});
await copyFile("bin/decoder/webp.wasm", `${outdir}/webp.wasm`);
await copyFile("converter/index.d.ts", `${outdir}/index.d.ts`);
