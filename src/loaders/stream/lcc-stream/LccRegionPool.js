import { regionAllocationSize } from "../../../data/RegionSplats.js";
import { RegionStreamBatch } from "../RegionStreamBatch.js";
/**
 * Node regions packed into shared batches. Each batch stores one SH degree,
 * the degree its data decoded with, so SH0 scenes allocate only base records.
 */
export class LccRegionPool {
  constructor(group, batchSplats) {
    this.group = group;
    this.batchSplats = batchSplats;
    this.entries = new Set();
  }
  /** First fit in an existing batch of the same degree, else a new batch. */
  allocate(count, numSh, name) {
    const size = regionAllocationSize(count);
    for (const entry of this.entries) {
      if (entry.numSh !== numSh) continue;
      const start = this.take(entry, size);
      if (start !== undefined) return { entry, start, size };
    }
    const entry = { numSh, free: [] };
    entry.batch = new RegionStreamBatch(
      Math.max(size, this.batchSplats),
      numSh,
      this.group,
      () => this.entries.delete(entry),
    );
    entry.batch.name = name;
    entry.batch.layers.mask = this.group.layers.mask;
    entry.free.push({ start: 0, size: entry.batch.source.maxSplats });
    this.entries.add(entry);
    return { entry, start: this.take(entry, size), size };
  }
  take(entry, size) {
    const index = entry.free.findIndex((range) => range.size >= size);
    if (index < 0) return undefined;
    const range = entry.free[index];
    const start = range.start;
    range.start += size;
    range.size -= size;
    if (!range.size) entry.free.splice(index, 1);
    return start;
  }
  /** Releasing a batch's last region disposes the batch. */
  release({ entry, start, size }) {
    entry.batch.releaseRegion(start);
    if (!this.entries.has(entry)) return;
    const free = entry.free;
    let index = free.findIndex((range) => range.start > start);
    if (index < 0) index = free.length;
    free.splice(index, 0, { start, size });
    // Merge with the following and preceding free ranges.
    if (index + 1 < free.length && start + size === free[index + 1].start) {
      free[index].size += free[index + 1].size;
      free.splice(index + 1, 1);
    }
    if (index > 0 && free[index - 1].start + free[index - 1].size === start) {
      free[index - 1].size += free[index].size;
      free.splice(index, 1);
    }
  }
  setLayers(mask) {
    for (const { batch } of this.entries) batch.layers.mask = mask;
  }
  dispose() {
    for (const { batch } of this.entries) {
      batch.removeFromParent();
      batch.dispose();
    }
    this.entries.clear();
  }
}
