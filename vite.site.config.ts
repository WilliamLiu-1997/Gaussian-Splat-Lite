import path from "node:path";
import { defineConfig } from "vite";
import arraybuffer from "vite-plugin-arraybuffer";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [
    arraybuffer(),
    glsl({
      include: ["**/*.glsl"],
    }),
  ],

  resolve: {
    alias: {
      "gaussian-splat-lite": path.resolve(__dirname, "src/index.ts"),
    },
  },

  build: {
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
    exclude: ["three", "three/webgpu", "three/tsl"],
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
});
