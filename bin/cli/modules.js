import { readFileSync } from "node:fs";

// The compiled nearest-code kernel, loaded before converting.
export function codebookKernel() {
  let bytes;
  try {
    bytes = readFileSync(new URL("../decoder/cluster.wasm", import.meta.url));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "SH clustering module not found; build it with npm run build:wasm:lod",
    );
  }
  return new WebAssembly.Module(bytes);
}
