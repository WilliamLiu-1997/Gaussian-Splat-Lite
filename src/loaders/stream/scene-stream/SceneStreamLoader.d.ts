import type { ReorderedSplatResult } from "../../../data/defines.js";
import type { SceneStreamOptions } from "./SceneStreamScheduler.js";
import type { BudgetedSceneSource } from "./memory.js";
export interface SceneSourceHandle {
  info: { numSplats: number; numSh: number; byteLength: number };
  extract(
    ranges: { start: number; count: number }[],
  ): Promise<ReorderedSplatResult[]>;
  dispose(): void | Promise<void>;
}
export declare class SceneStreamLoader {
  constructor(options: SceneStreamOptions, onChange: () => void);
  private readonly resourceVersions;
  private acceptResource;
  private acceptResponse;
  private readFile;
  load(
    source: BudgetedSceneSource,
    signal: AbortSignal,
  ): Promise<SceneSourceHandle>;
  get stats(): {
    downloadedBytes: number;
    peakWasmMemoryBytes: number;
    wasmMemoryBytes: number;
  };
  dispose(): void;
}
