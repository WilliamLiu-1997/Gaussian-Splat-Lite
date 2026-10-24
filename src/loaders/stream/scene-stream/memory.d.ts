import type { BudgetedSceneSource } from "./limits.js";
export {
  MAX_SOURCE_SPLATS,
  MAX_INPUT_BYTES,
  WASM32_BYTES,
  checkSourceCount,
  sourceLimits,
} from "./limits.js";
export type { BudgetedSceneSource, SourceDecodeLimits } from "./limits.js";
export declare function byteBudget(
  value: number | undefined,
  name: string,
): number;
export declare function regionMemory(
  count: number,
  shDegree: number,
): { cpu: number; gpu: number };
export declare function batchMemory(
  count: number,
  shDegree: number,
): { cpu: number; gpu: number };
export declare function sourceMemory(source: BudgetedSceneSource): number;
export declare class SceneMemory {
  readonly maxCpu: number;
  readonly maxGpu: number;
  cpu: number;
  gpu: number;
  constructor(cpu?: number, gpu?: number);
  reserve(cpu: number, gpu?: number): (() => void) | undefined;
}
