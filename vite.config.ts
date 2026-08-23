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

export default defineConfig(({ mode }) => {
  const isMinify = mode === "production";
  const isFirstPass = mode === "production";

  return {
    appType: "mpa",

    plugins: [
      arraybuffer(),
      glsl({
        include: ["**/*.glsl"],
      }),

      dts({ outDir: "dist/types" }),
    ],

    build: {
      minify: isMinify,
      lib: {
        entry: path.resolve(__dirname, "src/index.ts"),
        name: "GaussianSplatLite",
        formats: ["es", "cjs"],
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
        external: ["three", /^three\/addons/],
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

    server: {
      watch: {
        usePolling: true,
      },
      port: 8080,
    },

    optimizeDeps: {
      force: true,
      exclude: ["three"], // prevent Vite pre-bundling
    },
  };
});
