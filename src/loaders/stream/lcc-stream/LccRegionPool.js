import { regionAllocationSize } from "../../../data/RegionSplats.js";
import { getSplatShDegree } from "../../../data/splatData.js";
import { RegionStreamBatch } from "../RegionStreamBatch.js";
/** Reusable GPU slots shared by nodes, independently of their source files. */
export class LccRegionPool {
  constructor(group, capacity) {
    this.group = group;
    this.capacity = capacity;
    this.entries = new Set();
  }
  allocate(data) {
    const size = regionAllocationSize(data.numSplats);
    const numSh = getSplatShDegree(data.extra);
    let entry;
    let slot;
    for (const candidate of this.entries) {
      if (candidate.batch.numSh !== numSh) continue;
      slot = candidate.free.findIndex((range) => range.size >= size);
      if (slot >= 0) {
        entry = candidate;
        break;
      }
    }
    if (!entry) {
      entry = { free: [] };
      entry.batch = new RegionStreamBatch(
        Math.max(size, this.capacity),
        numSh,
        this.group,
        () => this.entries.delete(entry),
      );
      entry.batch.name = "lcc-batch";
      entry.free.push({ start: 0, size: entry.batch.source.maxSplats });
      this.entries.add(entry);
      slot = 0;
    }
    const range = entry.free[slot];
    const start = range.start;
    entry.batch.writeRegion(start, data);
    range.start += size;
    range.size -= size;
    if (!range.size) entry.free.splice(slot, 1);
    return { entry, batch: entry.batch, start, size, opacity: 0 };
  }
  release(region) {
    const { entry, start, size } = region;
    entry.batch.releaseRegion(start);
    if (!this.entries.has(entry)) return;
    entry.free.push({ start, size });
    entry.free.sort((a, b) => a.start - b.start);
    for (let i = entry.free.length - 1; i > 0; i--) {
      const previous = entry.free[i - 1];
      const current = entry.free[i];
      if (previous.start + previous.size === current.start) {
        previous.size += current.size;
        entry.free.splice(i, 1);
      }
    }
  }
  dispose() {
    for (const { batch } of this.entries) {
      batch.removeFromParent();
      batch.dispose();
    }
    this.entries.clear();
  }
}
