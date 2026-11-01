import { RadPagedSplats } from "../../../data/RadPagedSplats.js";
import { RAD_PAGE_SIZE, RAD_POOL_PAGE_COUNT } from "../../../data/defines.js";
import { getSplatTextureBytes } from "../../../data/splatData.js";
import { preparationRequestBytes } from "./prepareRadSelection.js";
import { radPoolBytes } from "./radLod.js";
/**
 * Plan freeing one pool after page reservation fails, including caches, by
 * consolidating pages into pools of the same SH degree. Drop only the oldest
 * unused pages needed to free one pool. Prefer fewer drops, then fewer moves.
 * Moves fill free and dropped slots, pools with the most pages in use first.
 * Reads slots and page use only; the caller releases drops and copies moves.
 */
function planConsolidation(pools, inUse, canMove) {
  const groups = new Map();
  for (const pool of pools) {
    const { numSh } = pool.storage;
    let group = groups.get(numSh);
    if (!group) {
      group = { free: 0, cached: [], pools: [] };
      groups.set(numSh, group);
    }
    const entry = { pool, pages: [], active: 0 };
    for (const page of pool.slots) {
      if (!page) group.free++;
      else {
        entry.pages.push(page);
        if (inUse(page)) entry.active++;
        else group.cached.push(page);
      }
    }
    group.pools.push(entry);
  }
  let best;
  for (const group of groups.values()) {
    // One pool can disappear once its degree has eight free slots in total.
    const needed = Math.max(0, RAD_POOL_PAGE_COUNT - group.free);
    if (group.cached.length < needed) continue;
    const drops = group.cached
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, needed);
    const dropped = new Set(drops);
    for (const entry of group.pools)
      entry.kept = entry.pages.filter((page) => !dropped.has(page));
    for (const entry of group.pools) {
      const moves = entry.kept;
      if (
        (moves.length && !canMove) ||
        moves.some(
          (page) => page.storage.phase !== "resident" || page.registration,
        ) ||
        (best &&
          (best.drops.length < drops.length ||
            (best.drops.length === drops.length &&
              best.entry.kept.length <= moves.length)))
      )
        continue;
      best = { group, entry, drops, dropped };
    }
  }
  if (!best) return undefined;
  const { group, entry, drops, dropped } = best;
  // Keep active pages together while retaining every cache not dropped.
  const destinations = group.pools
    .filter(
      (other) => other !== entry && other.kept.length < RAD_POOL_PAGE_COUNT,
    )
    .sort((a, b) => b.active - a.active);
  const pages = [...entry.kept];
  const moves = [];
  const touched = [entry.pool];
  for (const { pool } of destinations) {
    if (!pages.length) break;
    touched.push(pool);
    for (const [slot, page] of pool.slots.entries()) {
      if (page && !dropped.has(page)) continue;
      moves.push({ page: pages.shift(), pool, slot });
      if (!pages.length) break;
    }
  }
  return { drops, from: entry.pool, pools: touched, moves };
}
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
export class RadPagePools {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.pools = new Set();
  }
  [Symbol.iterator]() {
    return this.pools.values();
  }
  has(pool) {
    return this.pools.has(pool);
  }
  /** Pool work pauses reservation, expiry and consolidation. */
  get busy() {
    return !!(this.allocation || this.merge);
  }
  /** Storage being allocated or moved, outside the resident statistics. */
  get pendingBytes() {
    return (
      (this.allocation?.bytes ?? 0) +
      (this.allocation?.storage?.getByteLength() ?? 0) +
      (this.merge?.bytes ?? 0)
    );
  }
  get pendingGpuBytes() {
    return this.allocation?.storage?.textureByteLength ?? 0;
  }
  /** Every page holding a slot, written or awaiting its write. */
  *pages() {
    for (const pool of this.pools)
      for (const page of pool.slots) if (page) yield page;
  }
  /** Every input's views, one per pool that holds its records. */
  *views() {
    for (const pool of this.pools) yield* pool.views.values();
  }
  /** One input's views. */
  *viewsOf(input) {
    for (const pool of this.pools) {
      const batch = pool.views.get(input);
      if (batch) yield batch;
    }
  }
  /** Dispose one input's views; the scheduler releases its pages. */
  removeViews(input) {
    for (const pool of this.pools) {
      pool.views.get(input)?.dispose();
      pool.views.delete(input);
    }
  }
  /** Remove every displayed cut. Returns whether any view drew Splats. */
  clearViews() {
    let changed = false;
    for (const pool of this.pools) {
      pool.storage.clearSelection();
      for (const batch of pool.views.values()) {
        changed = batch.numSplats > 0 || changed;
        batch.dispose();
      }
      pool.views.clear();
    }
    return changed;
  }
  /** Pages of merging pools stay until the moves publish or cancel. */
  isMerging(page) {
    return !!this.merge?.pools.includes(page.storage?.pool);
  }
  inUse(page) {
    return (
      this.scheduler.isPageRequired(page) || this.scheduler.isPagePinned(page)
    );
  }
  /**
   * Give a decoded page a free slot in the pool with the most pages in use,
   * otherwise allocate a pool within the resident budgets or take the slot of
   * the least recently used page not in use. Returns whether the page has a slot.
   */
  reserve(page) {
    const { scheduler } = this;
    const { input } = page;
    let cpu = scheduler.loader.residentCpuOverheadBytes;
    let gpu = 0;
    let oldest;
    let available;
    let mostActive = -1;
    for (const pool of this.pools) {
      cpu += pool.residentBytes.cpu;
      gpu += pool.residentBytes.gpu;
      if (pool.storage.numSh !== input.numSh) continue;
      const active = pool.slots.filter(
        (other) => other && this.inUse(other),
      ).length;
      for (const [slot, other] of pool.slots.entries()) {
        if (!other) {
          if (active > mostActive) {
            available = { pool, slot };
            mostActive = active;
          }
        } else if (
          !this.inUse(other) &&
          (!oldest || other.lastUsed < oldest.lastUsed)
        ) {
          oldest = other;
        }
      }
    }
    if (!available) {
      const bytes = radPoolBytes(input.costs);
      if (
        cpu + bytes.cpu <= scheduler.maxResidentCpuBytes &&
        gpu + bytes.gpu <= scheduler.maxResidentGpuBytes
      ) {
        void this.allocate(input);
        return false;
      }
      if (!oldest) return false;
      const { pool, slot } = oldest.storage;
      scheduler.releasePage(oldest);
      available = { pool, slot };
    }
    const { pool, slot } = available;
    pool.slots[slot] = page;
    page.storage.pool = pool;
    page.storage.slot = slot;
    return true;
  }
  async allocate(input) {
    const { scheduler } = this;
    const allocation = {
      residentBytes: radPoolBytes(input.costs),
      bytes: getSplatTextureBytes(
        RAD_POOL_PAGE_COUNT * RAD_PAGE_SIZE,
        input.numSh,
      ),
      cancelled: false,
    };
    this.allocation = allocation;
    try {
      const arrays = await scheduler.loader.allocateStorage(input.numSh);
      if (allocation.cancelled) return;
      const storage = new RadPagedSplats({
        numSh: input.numSh,
        deferAllocation: true,
      });
      storage.uploadQueue = scheduler.uploads;
      allocation.storage = storage;
      allocation.arrays = arrays;
    } catch (error) {
      if (!allocation.cancelled) scheduler.stopRefinement(error);
    } finally {
      if (allocation.cancelled) this.allocation = undefined;
      scheduler.changed();
    }
  }
  /** Write decoded pages to their slots in this order while uploads allow. */
  write(pages) {
    let changed = false;
    for (const page of pages) {
      const storage = page?.storage;
      if (storage?.phase !== "decoded" || storage.slot === undefined) continue;
      const { pool, slot } = storage;
      const bytes = pool.storage.getUploadBytes(slot, slot + 1);
      if (!this.scheduler.uploads.canAdd(bytes)) break;
      pool.storage.writePage(slot, storage.data, page.input.numSh);
      page.storage = { phase: "resident", pool, slot };
      page.expiresAt = undefined;
      changed = true;
    }
    return changed;
  }
  /** Drop a page's records; moves involving its pool are cancelled. */
  release(page) {
    const storage = page.storage;
    const slot = storage?.slot;
    if (slot !== undefined) {
      if (this.merge?.pools.includes(storage.pool)) this.cancel();
      storage.pool.slots[slot] = undefined;
      storage.pool.storage.releasePage(slot);
    }
    page.storage = undefined;
    page.expiresAt = undefined;
  }
  /**
   * Release pages unused for a cooldown, then empty pools. Required pages
   * restart theirs; a traversal snapshot delays release without renewing
   * unused pages.
   */
  releaseUnused(now, allowRelease) {
    if (this.busy) return false;
    const { scheduler } = this;
    let changed = false;
    for (const page of this.pages()) {
      if (scheduler.isPageRequired(page)) {
        page.expiresAt = undefined;
        continue;
      }
      page.expiresAt ??= now + scheduler.cooldownMs;
      if (!allowRelease || now < page.expiresAt || scheduler.isPagePinned(page))
        continue;
      scheduler.releasePage(page);
      changed = true;
    }
    return this.releaseEmpty() || changed;
  }
  /**
   * Free capacity after page reservation fails; see planConsolidation. Call
   * only without pending pool work. Copies advance within the upload budget
   * and publish together without renewing cache expiry.
   */
  consolidate(canMove) {
    // Releasing an empty pool frees capacity without copying.
    if (this.releaseEmpty()) return;
    const plan = planConsolidation(
      this.pools,
      (page) => this.inUse(page),
      canMove,
    );
    if (!plan) return;
    for (const page of plan.drops) this.scheduler.releasePage(page);
    if (!plan.moves.length) {
      this.releaseEmpty();
      return;
    }
    const merge = {
      from: plan.from,
      pools: plan.pools,
      moves: new Map(
        plan.moves.map((move) => [move.page, { ...move, copied: false }]),
      ),
      cancelled: false,
      bytes: 0,
    };
    this.merge = merge;
    void this.prepareMerge(merge);
  }
  /** Prepare the displayed cut for the affected pools as if moves were published. */
  async prepareMerge(merge) {
    const { scheduler } = this;
    try {
      // Only file indices cross workers; live pool storage stays attached.
      for (const batch of this.views()) merge.bytes += batch.numSplats * 4;
      const sources = await scheduler.snapshotDisplayed();
      if (merge.cancelled) return;
      const pools = scheduler.snapshotPools(
        sources,
        merge.pools,
        (page) => merge.moves.get(page) ?? page.storage,
      );
      merge.bytes = preparationRequestBytes(sources, pools, 1);
      merge.result = await scheduler.loader.prepareMerge({ sources, pools });
    } catch (error) {
      if (!merge.cancelled) scheduler.stopRefinement(error);
    } finally {
      if (merge.cancelled) this.merge = undefined;
      scheduler.changed();
    }
  }
  /**
   * Advance page copies and finish pool work once its uploads drain. Returns
   * whether it needs rendered frames; worker replies request their own.
   */
  update() {
    let frames = false;
    if (this.allocation) frames = this.updateAllocation() || frames;
    if (this.merge) frames = this.updateMerge() || frames;
    return frames;
  }
  updateAllocation() {
    const allocation = this.allocation;
    const { storage, arrays } = allocation;
    if (!arrays) return false;
    // Uploads drain only when the scene renders.
    if (storage.pendingUploadBytes) return true;
    if (arrays.length) {
      // Initialize all packed textures together, even before the pool has a view.
      for (const array of arrays) {
        const texture = storage.allocateTexture(array);
        allocation.bytes -= array.byteLength;
        texture.addLayerUpdate(0);
        texture.needsUpdate = true;
      }
      arrays.length = 0;
      this.scheduler.uploads.add(storage);
      return true;
    }
    this.pools.add({
      storage,
      residentBytes: allocation.residentBytes,
      slots: new Array(RAD_POOL_PAGE_COUNT).fill(undefined),
      views: new Map(),
    });
    this.allocation = undefined;
    return true;
  }
  updateMerge() {
    const merge = this.merge;
    if (merge.cancelled) return false;
    try {
      // Keep original slots and views live while copies span multiple uploads.
      for (const move of merge.moves.values()) {
        if (move.copied) continue;
        const { page, pool, slot } = move;
        const bytes = pool.storage.getUploadBytes(slot, slot + 1);
        if (!this.scheduler.uploads.canAdd(bytes)) return true;
        pool.storage.copyPage(merge.from.storage, page.storage.slot, slot);
        move.copied = true;
      }
    } catch (error) {
      this.scheduler.stopRefinement(error);
      return false;
    }
    const uploading = merge.pools.some(
      (pool) => pool.storage.pendingUploadBytes,
    );
    if (!merge.result || uploading) return uploading;
    // Publish locations and views together; preserve chunk caches and page expiry.
    for (const { page, pool, slot } of merge.moves.values()) {
      merge.from.slots[page.storage.slot] = undefined;
      pool.slots[slot] = page;
      page.storage = { phase: "resident", pool, slot };
    }
    this.scheduler.commitPools(merge.result, merge.pools);
    this.merge = undefined;
    this.releaseEmpty();
    return true;
  }
  cancel() {
    const allocation = this.allocation;
    if (allocation) {
      allocation.cancelled = true;
      allocation.storage?.dispose();
      // An in-flight allocator stays charged until its worker replies.
      if (allocation.arrays) this.allocation = undefined;
    }
    const merge = this.merge;
    if (merge) {
      merge.cancelled = true;
      for (const { pool, slot } of merge.moves.values())
        pool.storage.releasePage(slot);
      if (merge.result) this.merge = undefined;
    }
  }
  releaseEmpty() {
    let changed = false;
    for (const pool of this.pools) {
      // Even an empty snapshot keeps its storage until the worker reply is handled.
      if (
        pool.slots.some(Boolean) ||
        this.scheduler.preparation?.pools.includes(pool) ||
        this.merge?.pools.includes(pool)
      )
        continue;
      this.disposePool(pool);
      changed = true;
    }
    return changed;
  }
  disposePool(pool) {
    for (const batch of pool.views.values()) batch.dispose();
    pool.storage.dispose();
    this.pools.delete(pool);
  }
  dispose() {
    for (const pool of this.pools) this.disposePool(pool);
  }
}
