import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import arraybuffer from "vite-plugin-arraybuffer";
import dts from "vite-plugin-dts";
import glsl from "vite-plugin-glsl";

const wasmPackage = "rust/gaussian-splat-rs/pkg";
if (!fs.existsSync(wasmPackage)) {
  console.error(
    "Gaussian Splat Lite WebAssembly package is missing. Run `npm run build:wasm` first.",
  );
  process.exit(1);
}

function externalizeThreeCoreForCommonJS() {
  return {
    name: "externalize-three-core-for-commonjs",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (
        source === "./three.core.js" &&
        importer?.endsWith("/three/build/three.webgpu.js")
      ) {
        return { id: "three", external: true };
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const isMinify = mode.startsWith("production");
  const isCommonJS = mode.endsWith("-cjs");
  const isFirstPass = mode === "production-es";

  return {
    appType: "mpa",

    plugins: [
      arraybuffer(),
      glsl({
        include: ["**/*.glsl"],
      }),

      ...(isCommonJS ? [] : [dts({ outDir: "dist/types" })]),
      ...(isCommonJS ? [externalizeThreeCoreForCommonJS()] : []),
    ],

    build: {
      minify: isMinify,
      lib: {
        entry: path.resolve(__dirname, "src/index.ts"),
        name: "GaussianSplatLite",
        formats: [isCommonJS ? "cjs" : "es"],
        fileName: (format) => {
          if (format === "es") {
            const base = "gaussian-splat-lite.module";
            return isMinify ? `${base}.min.js` : `${base}.js`;
          }
          return isMinify
            ? "gaussian-splat-lite.min.cjs"
            : "gaussian-splat-lite.cjs";
        },
      },
      sourcemap: true,
      rollupOptions: {
        // Three's WebGPU/TSL entries are ESM-only. Keep them external in the
        // ESM artifact and bundle them into CJS while preserving core identity.
        external: isCommonJS ? ["three"] : ["three", /^three\//],
        output: {
          globals: {
            three: "THREE",
          },
        },
      },
      emptyOutDir: isFirstPass,
    },

    worker: {
      rollupOptions: {
        treeshake: "smallest",
      },
      plugins: () => [
        glsl({
          include: ["**/*.glsl"],
        }),
      ],
    },
  };
});
