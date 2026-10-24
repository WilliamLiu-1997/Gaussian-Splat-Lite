import type { SceneSourceHandle } from "./SceneStreamLoader.js";
import type { SceneStreamOptions } from "./SceneStreamScheduler.js";
import type { BudgetedSceneSource, SceneMemory } from "./memory.js";
export declare function logicalUrl(url: string): string;
export declare function readSceneBytes(
  url: string,
  options: SceneStreamOptions,
  signal: AbortSignal,
  limit: number,
  optional?: boolean,
): Promise<Uint8Array | undefined>;
export declare class SceneBudgetError extends Error {
  readonly sourceKey: string;
  readonly phase: string;
  readonly requestedBytes: number;
  readonly availableBytes: number;
  constructor(
    sourceKey: string,
    phase: string,
    requestedBytes: number,
    availableBytes: number,
  );
}
export interface SceneSourceLease {
  promise: Promise<SceneSourceHandle>;
  /**
   * Resolves when the last owner releases a ready source, without waiting for idle eviction.
   * Canceled/inflight sources wait for decode completion and cache disposal acknowledgement.
   * Repeated calls return the same promise.
   */
  release(): Promise<void>;
}
export declare class SceneSources {
  readonly entries: Map<string, unknown>;
  readonly closing: Set<Promise<void>>;
  constructor(
    load: (
      source: BudgetedSceneSource,
      signal: AbortSignal,
    ) => Promise<SceneSourceHandle>,
    memory: SceneMemory,
    signal: AbortSignal,
    onChange?: () => void,
  );
  /** Sum of handle.info.byteLength once per retained source, including active/idle sources and unacknowledged eviction; excludes WASM and decode envelopes. */
  get cachedBytes(): number;
  /** Source CPU reservations still pending decode/cleanup; excludes shared WASM ownership and ready caches. */
  get pendingBytes(): number;
  /** Starts idle cache eviction under pressure; reservations remain charged until disposal is acknowledged. */
  trim(cpu?: number, gpu?: number): void;
  /**
   * Ready sources retain their worker handle for a 2000 ms idle cooldown, unless pressure or disposal evicts them sooner.
   * Pinned worker loss invalidates its sources; source reservations remain until load completion and disposal acknowledgement.
   */
  acquire(source: BudgetedSceneSource): SceneSourceLease | undefined;
  acquireWhenAvailable(
    source: BudgetedSceneSource,
    signal: AbortSignal,
  ): Promise<SceneSourceLease>;
  wake(): void;
  dispose(): Promise<void>;
}
