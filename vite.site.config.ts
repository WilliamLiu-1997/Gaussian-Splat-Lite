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
