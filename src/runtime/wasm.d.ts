export declare const WASM_MODULE: Promise<WebAssembly.Module>;
/** Initializes the main-thread WASM instance used by raycasting. */
export declare const WASM_READY: Promise<void>;
export declare function isInitialized(): boolean;
