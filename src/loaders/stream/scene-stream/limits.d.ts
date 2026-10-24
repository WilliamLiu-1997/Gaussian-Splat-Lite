import type { SceneSource } from "./SceneStreamScheduler.js";
export declare const MAX_SOURCE_SPLATS = 8000000;
export declare const MAX_INPUT_BYTES: number;
export declare const WASM32_BYTES: number;
export declare function checkSourceCount(count: number): number;
export interface SourceDecodeLimits {
  maxPoints: number;
  maxInputBytes: number;
  maxWasmBytes: number;
  maxDecoderBytes: number;
  outputBytes: number;
}
export type BudgetedSceneSource = SceneSource & {
  maxPoints?: number;
  maxInputBytes?: number;
  maxWasmBytes?: number;
  /** Internal admission callback; never sent to the worker. */
  admit?: (update: {
    maxPoints?: number;
    maxInputBytes?: number;
    maxWasmBytes?: number;
  }) => SourceDecodeLimits;
  /** Internal transfer of the WASM cap to worker-lifetime ownership; capacity is a completed-RPC sample. */
  pinWasm?: (worker: object, capacity: number, disposed: Promise<void>) => void;
};
export declare function sourceLimits(
  source: BudgetedSceneSource,
): SourceDecodeLimits;
