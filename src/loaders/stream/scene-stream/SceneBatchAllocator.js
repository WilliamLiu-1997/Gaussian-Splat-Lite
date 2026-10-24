import {
  sogBatchAllocationSize,
  sogBatchTextureLayout,
} from "../../../data/SogRegionSplats.js";
import { SH_ARRAY_COUNTS, getSplatShDegree } from "../../../data/splatData.js";
import { batchMemory, checkSourceCount } from "./memory.js";

function plan(pages, ranges) {
  const layouts = [...pages].map((page) => ({
    page,
    degree: page.degree,
    free: page.free.map((gap) => ({ ...gap })),
  }));
  const slots = [];
  for (const range of ranges) {
    checkSourceCount(range.count);
    const size = sogBatchAllocationSize(range.count);
    const degree = range.source.shDegree;
    let layout = layouts.find(
      (item) =>
        item.degree === degree && item.free.some((gap) => gap.count >= size),
    );
    if (!layout) {
      const capacity = sogBatchTextureLayout(size).capacity;
      layout = { degree, capacity, free: [{ start: 0, count: capacity }] };
      layouts.push(layout);
    }
    const gap = layout.free.find((gap) => gap.count >= size);
    slots.push({ layout, start: gap.start, size, count: range.count });
    gap.start += size;
    gap.count -= size;
  }
  const allocation = layouts
    .filter((layout) => !layout.page)
    .reduce(
      (sum, layout) => {
        const bytes = batchMemory(layout.capacity, layout.degree);
        sum.cpu += bytes.cpu;
        sum.gpu += bytes.gpu;
        return sum;
      },
      { cpu: 0, gpu: 0 },
    );
  return { layouts, slots, ...allocation };
}

/** The same block-aligned page plan used for minimum admission and live allocation. */
export function sceneBatchMemory(ranges) {
  const { cpu, gpu } = plan([], ranges);
  return { cpu, gpu };
}

/** Scene ranges own slots; only backing pages own memory and render meshes. */
export class SceneBatchAllocator {
  constructor(memory, createBatch) {
    this.memory = memory;
    this.createBatch = createBatch;
    this.pages = new Set();
  }
  estimate(ranges) {
    const { cpu, gpu } = plan(this.pages, ranges);
    return { cpu, gpu };
  }
  reserve(ranges) {
    const allocation = plan(this.pages, ranges);
    if (
      this.memory.cpu + allocation.cpu > this.memory.maxCpu ||
      this.memory.gpu + allocation.gpu > this.memory.maxGpu
    )
      return undefined;
    for (const layout of allocation.layouts) {
      if (!layout.page) {
        const bytes = batchMemory(layout.capacity, layout.degree);
        layout.page = {
          degree: layout.degree,
          capacity: layout.capacity,
          slots: new Set(),
          ...bytes,
          releaseMemory: this.memory.reserve(bytes.cpu, bytes.gpu),
        };
        this.pages.add(layout.page);
      }
      layout.page.free = layout.free;
    }
    return allocation.slots.map(({ layout, ...slot }) => {
      slot.page = layout.page;
      slot.published = false;
      slot.released = false;
      slot.page.slots.add(slot);
      return slot;
    });
  }
  async write(slot, data, metadata) {
    const page = slot.page;
    slot.metadata = metadata;
    slot.degree = getSplatShDegree(data.extra);
    if (slot.degree > page.degree || data.numSplats !== slot.count)
      throw new Error(
        "Extracted scene range does not match its admitted allocation",
      );
    page.promise ??= Promise.resolve().then(async () => {
      const batch = await this.createBatch(page.capacity, page.degree);
      page.batch = batch;
      batch.userData.sceneStream = { regions: new Map() };
      const raycast = batch.raycast;
      if (raycast)
        batch.raycast = (raycaster, hits) => {
          const first = hits.length;
          raycast.call(batch, raycaster, hits);
          for (let i = first; i < hits.length; i++) {
            const hit = hits[i];
            const storage = batch.source.getStorageIndex(hit.index);
            for (const region of page.slots)
              if (
                region.published &&
                storage >= region.start &&
                storage < region.start + region.count
              ) {
                hit.sceneStream = region.metadata;
                break;
              }
          }
        };
      return batch;
    });
    const batch = await page.promise;
    // Whole-file descriptors advertise an SH upper bound, not the decoded degree.
    const extra = { ...data.extra };
    for (
      let index = SH_ARRAY_COUNTS[slot.degree];
      index < SH_ARRAY_COUNTS[page.degree];
      index++
    )
      extra[`shBlock${index}`] = new Uint32Array(data.numSplats * 4);
    batch.writeRegion(slot.start, { ...data, extra });
    batch.userData.sceneStream.regions.set(slot.start, metadata);
  }
  publish(slot, layers) {
    const batch = slot.page.batch;
    batch.layers.mask = layers;
    batch.setRegionOpacity(slot.start, 1);
    slot.published = true;
  }
  release(slot) {
    if (slot.released) return;
    slot.released = true;
    slot.published = false;
    const page = slot.page;
    const batch = page.batch;
    if (batch) {
      batch.setRegionOpacity(slot.start, 0);
      batch.source?.release(slot.start);
      batch.slots?.delete(slot.start);
      batch.userData.sceneStream.regions.delete(slot.start);
    }
    page.slots.delete(slot);
    page.free.push({ start: slot.start, count: slot.size });
    page.free.sort((a, b) => a.start - b.start);
    for (let i = page.free.length - 1; i > 0; i--) {
      const previous = page.free[i - 1];
      const current = page.free[i];
      if (previous.start + previous.count === current.start) {
        previous.count += current.count;
        page.free.splice(i, 1);
      }
    }
    if (!page.slots.size) {
      this.pages.delete(page);
      batch?.removeFromParent();
      batch?.dispose();
      page.releaseMemory();
    }
  }
  get pendingBytes() {
    let bytes = 0;
    for (const page of this.pages)
      if (![...page.slots].some((slot) => slot.published))
        bytes += page.cpu + page.gpu;
    return bytes;
  }
}
