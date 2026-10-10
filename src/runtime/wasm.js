import initWasm from "gaussian-splat-rs";
import wasmBytes from "gaussian-splat-rs/gaussian_splat_rs_bg.wasm?arraybuffer&base64";
export const WASM_MODULE = WebAssembly.compile(wasmBytes);
let initialized = false;
/** Initializes the main-thread WASM instance used by raycasting. */
export const WASM_READY = initWasm({ module_or_path: WASM_MODULE }).then(() => {
  initialized = true;
});
// Consumers still receive the rejection; loading the module alone must not
// create an unhandled rejection when WebAssembly initialization fails.
void WASM_READY.catch(() => {});
export function isInitialized() {
  return initialized;
}
