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
    ],

    build: {
      minify: isMinify,
      lib: {
        entry: {
          "gaussian-splat-lite": path.resolve(__dirname, "src/index.ts"),
          "gaussian-splat-lite-plugins": path.resolve(
            __dirname,
            "src/plugins/index.ts",
          ),
        },
        name: "GaussianSplatLite",
        formats: [isCommonJS ? "cjs" : "es"],
        fileName: (format, entryName) => {
          if (format === "es") {
            const base = `${entryName}.module`;
            return isMinify ? `${base}.min.js` : `${base}.js`;
          }
          return isMinify ? `${entryName}.min.cjs` : `${entryName}.cjs`;
        },
      },
      sourcemap: true,
      rollupOptions: {
        // Share Three's core and TSL state with the application in both formats.
        external: ["three", /^three\//],
        output: {
          chunkFileNames: `chunks/[name]-${mode}-[hash].${isCommonJS ? "cjs" : "js"}`,
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
        {
          name: "omit-worker-sourcemaps",
          generateBundle(_options, bundle) {
            for (const [name, entry] of Object.entries(bundle)) {
              if (entry.type === "asset" && name.endsWith(".map"))
                delete bundle[name];
              else if (entry.type === "chunk") {
                entry.map = null;
                entry.code = entry.code.replace(
                  /\n?\/\/# sourceMappingURL=.*$/gm,
                  "",
                );
              }
            }
          },
        },
        glsl({
          include: ["**/*.glsl"],
        }),
      ],
    },
  };
});
