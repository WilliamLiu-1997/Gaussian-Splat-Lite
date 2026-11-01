import type { RadPagedSplats } from "../../../data/RadPagedSplats.js";
import type { RadStreamBatch } from "./RadStreamBatch.js";
import type { RadStreamScheduler } from "./RadStreamScheduler.js";
/** A page's records: decoded and awaiting a slot, or written to one. */
type RadPage = {
  readonly index: number;
  readonly input: {
    readonly id: number;
    readonly numSh: number;
    readonly costs: { readonly cpu: number; readonly gpu: number };
  };
  lastUsed: number;
  expiresAt?: number;
  registration?: Promise<void>;
  storage?: {
    phase: "decoded" | "resident";
    pool?: RadPagePool;
    slot?: number;
  };
};
/** One pool's storage, its slots and the views drawn from it, one per input. */
type RadPagePool = {
  readonly storage: RadPagedSplats;
  /** Resident bytes charged for all eight slots. */
  readonly residentBytes: { readonly cpu: number; readonly gpu: number };
  readonly slots: (RadPage | undefined)[];
  views: Map<unknown, RadStreamBatch>;
};
/**
 * Eight-slot RAD page pools, one SH degree each, and the rules for where pages
 * live: decoded pages favor free slots in pools with the most pages in use,
 * then a new pool within the resident budgets, or the slot of the least
 * recently used page not in use.
 * Unused pages expire after a cooldown, and empty pools are released.
 * Allocation failures can consolidate pools of the same degree. The scheduler
 * identifies pages in use, releases pages and rebuilds views after moves;
 * selection refers to pages, never to slots.
 */
export declare class RadPagePools {
  private readonly scheduler;
  private readonly pools;
  private allocation?;
  private merge?;
  constructor(scheduler: RadStreamScheduler);
  [Symbol.iterator](): IterableIterator<RadPagePool>;
  has(pool: RadPagePool): boolean;
  /** Pool work pauses reservation, expiry and consolidation. */
  get busy(): boolean;
  /** Storage being allocated or moved, outside the resident statistics. */
  get pendingBytes(): number;
  get pendingGpuBytes(): number;
  /** Every page holding a slot, written or awaiting its write. */
  pages(): Generator<RadPage, void, unknown>;
  /** Every input's views, one per pool that holds its records. */
  views(): Generator<RadStreamBatch, void, unknown>;
  /** One input's views. */
  viewsOf(input: unknown): Generator<RadStreamBatch, void, unknown>;
  /** Dispose one input's views; the scheduler releases its pages. */
  removeViews(input: unknown): void;
  /** Remove every displayed cut. Returns whether any view drew Splats. */
  clearViews(): boolean;
  /** Pages of merging pools stay until the moves publish or cancel. */
  isMerging(page: RadPage): boolean;
  private inUse;
  /**
   * Give a decoded page a free slot in the pool with the most pages in use,
   * otherwise allocate a pool within the resident budgets or take the slot of
   * the least recently used page not in use. Returns whether the page has a slot.
   */
  reserve(page: RadPage): boolean;
  private allocate;
  /** Write decoded pages to their slots in this order while uploads allow. */
  write(pages: Iterable<RadPage>): boolean;
  /** Drop a page's records; moves involving its pool are cancelled. */
  release(page: RadPage): void;
  /**
   * Release pages unused for a cooldown, then empty pools. Required pages
   * restart theirs; a traversal snapshot delays release without renewing
   * unused pages.
   */
  releaseUnused(now: number, allowRelease: boolean): boolean;
  /**
   * Free capacity after page reservation fails by consolidating pages of one
   * SH degree, dropping only the oldest unused pages needed. Call only without
   * pending pool work. Copies advance within the upload budget
   * and publish together without renewing cache expiry.
   */
  consolidate(canMove: boolean): void;
  /** Prepare the displayed cut for the affected pools as if moves were published. */
  private prepareMerge;
  /**
   * Advance page copies and finish pool work once its uploads drain. Returns
   * whether it needs rendered frames; worker replies request their own.
   */
  update(): boolean;
  private updateAllocation;
  private updateMerge;
  cancel(): void;
  releaseEmpty(): boolean;
  private disposePool;
  dispose(): void;
}
export {};
