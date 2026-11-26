import path from "node:path";
import { defineConfig } from "vite";
import arraybuffer from "vite-plugin-arraybuffer";
import glsl from "vite-plugin-glsl";

import { converterPages, converterRuntime } from "./converter/vite.js";
import { examples } from "./examples/catalog.js";

export default defineConfig({
  appType: "mpa",
  plugins: [
    converterRuntime(),
    converterPages(),
    arraybuffer(),
    glsl({
      include: ["**/*.glsl"],
    }),
  ],

  resolve: {
    alias: {
      "gaussian-splat-lite": path.resolve(__dirname, "src/index.js"),
    },
  },

  build: {
    target: "es2022",
    rollupOptions: {
      input: [
        "index.html",
        "converter/index.html",
        "examples/index.html",
        ...examples.map(({ id }) => `examples/examples/${id}/index.html`),
      ],
    },
    outDir: "site-dist",
    sourcemap: true,
  },

  server: {
    watch: {
      // Keep polling for external drives without scanning Rust build artifacts.
      usePolling: true,
      interval: 1000,
      ignored: ["**/rust/target/**", "**/dist/**", "**/._*"],
    },
    port: 8080,
  },

  optimizeDeps: {
    include: [
      "fflate",
      "@jspm/core/nodelibs/path",
      "@jspm/core/nodelibs/buffer",
    ],
    exclude: ["three", "three/webgpu", "three/tsl"],
  },

  worker: {
    format: "es",
    rollupOptions: {
      treeshake: "smallest",
      output: {
        entryFileNames: (chunk) =>
          chunk.facadeModuleId?.includes("/converter/")
            ? "converter/assets/[name]-[hash].js"
            : "assets/[name]-[hash].js",
      },
    },
    plugins: () => [
      converterRuntime(),
      arraybuffer(),
      glsl({
        include: ["**/*.glsl"],
      }),
    ],
  },
});
