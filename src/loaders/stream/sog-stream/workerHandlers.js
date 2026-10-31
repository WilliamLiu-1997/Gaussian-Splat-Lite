import { sogBatchAllocationSize } from "../../../data/SogRegionSplats.js";
import {
  SH_ARRAY_COUNTS,
  SH_KEYS,
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { extractSplatRange } from "../../../data/splatRange.js";
import { reorderSplats, restoreSplatOrder } from "../../morton.js";
import {
  SOG_LOD_STRIDE,
  packSogLodIndex,
  parseSogLodManifest,
  selectSogLods,
} from "./sogLod.js";
import { SogVisibility } from "./sogVisibility.js";
/** LOD workers parse the index once before selection; other workers own chunk caches. */
export function createSogStreamHandlers(decodeSplats) {
  const sogChunks = new Map();
  const sogLoads = new Map();
  // Each input keeps its own octree and median region size for LOD distance.
  const sources = new Map();
  let nextLeaf = 0;
  let nextFile = 0;
  function parseSogIndex({ id, bytes, baseUrl }) {
    const manifest = parseSogLodManifest(
      JSON.parse(new TextDecoder().decode(bytes)),
      baseUrl,
    );
    // Keep the environment so the scheduler can enable or skip it later.
    const environment = manifest.environment ? manifest.files.length : -1;
    if (environment >= 0)
      manifest.files.push({ url: manifest.environment, count: -1 });
    const index = packSogLodIndex(manifest);
    const leafBase = nextLeaf;
    const fileBase = nextFile;
    // IDs are never reused, including after removal. Selection uses uint32 IDs.
    const leafEnd = leafBase + index.leafOffsets.length - 1;
    const fileEnd = fileBase + index.urls.length;
    if (leafEnd > 0x100000000 || !Number.isSafeInteger(fileEnd))
      throw new Error("SOG streaming index capacity exceeded");
    const lods = index.lods.slice();
    const batchStarts = new Float64Array(lods.length / SOG_LOD_STRIDE);
    const batchCapacities = new Float64Array(index.urls.length);
    // Manifest validation guarantees disjoint ranges within each chunk.
    // Preserve stable slots without rebuilding per-range Maps on the main thread.
    for (let offset = 0; offset < lods.length; offset += SOG_LOD_STRIDE) {
      const file = lods[offset + 1];
      if (file < 0) continue;
      batchStarts[offset / SOG_LOD_STRIDE] = batchCapacities[file];
      batchCapacities[file] += sogBatchAllocationSize(lods[offset + 3]);
      lods[offset + 1] += fileBase;
    }
    sources.set(id, {
      index,
      visibility: new SogVisibility(index),
      leafBase,
    });
    nextLeaf = leafEnd;
    nextFile = fileEnd;
    return {
      urls: index.urls,
      counts: index.counts.slice(),
      leafOffsets: index.leafOffsets.slice(),
      lods,
      batchStarts,
      batchCapacities,
      bounds: index.bounds.slice(),
      leafBase,
      fileBase,
      environment: environment < 0 ? -1 : fileBase + environment,
      retainedIndexBytes:
        index.bounds.byteLength +
        index.leafBounds.byteLength +
        index.leafOffsets.byteLength +
        index.lods.byteLength +
        index.counts.byteLength,
    };
  }
  function releaseSogIndex({ id }) {
    sources.delete(id);
  }
  function selectSogLod(request) {
    const regions = [];
    let lodLevels = 0;
    request.sources.forEach(({ id, transform }, source) => {
      const { index, visibility, leafBase } = sources.get(id);
      const collected = visibility.collect({
        ...request,
        transform,
      });
      collected.forEach((region, local) => {
        region.leaf.id = leafBase + local;
        region.source = source;
        regions.push(region);
      });
      lodLevels = Math.max(lodLevels, index.lodLevels);
    });
    const targets = selectSogLods(regions, lodLevels, request);
    regions.sort((a, b) => a.distance - b.distance || a.leaf.id - b.leaf.id);
    // Stable source/leaf IDs let the scheduler retain other inputs unchanged.
    const result = new Uint32Array(targets.size * 3);
    let offset = 0;
    for (const { leaf, source } of regions) {
      const target = targets.get(leaf.id);
      if (!target) continue;
      result[offset++] = request.sources[source].id;
      result[offset++] = leaf.id;
      result[offset++] = leaf.lods.indexOf(target);
    }
    return result;
  }
  function cacheSogChunk({ id, data, maxSh }) {
    // Custom loaders may return higher SH than this scheduler retains.
    for (const key of SH_KEYS.slice(SH_ARRAY_COUNTS[maxSh]))
      delete data.extra[key];
    // A custom loader may have reordered the whole chunk. Restore file ranges
    // once; each extracted region is reordered independently below.
    restoreSplatOrder(data);
    sogChunks.set(id, data);
    return {
      numSplats: data.numSplats,
      numSh: getSplatShDegree(data.extra),
      byteLength: getSplatByteLength(data),
    };
  }
  async function loadSogChunk({ id, ...args }, options) {
    const controller = new AbortController();
    sogLoads.set(id, controller);
    try {
      const data = await decodeSplats(
        { ...args, signal: controller.signal },
        options,
      );
      controller.signal.throwIfAborted();
      return cacheSogChunk({ id, data, maxSh: args.maxSh });
    } finally {
      sogLoads.delete(id);
    }
  }
  function extractSogRegions({ id, ranges }) {
    const source = sogChunks.get(id);
    if (!source) throw new Error("Streaming chunk is no longer cached");
    // Fixed batch storage supplies alignment and reads centers from packed XYZ.
    return ranges.map(({ start, count }) => {
      const data = extractSplatRange(source, start, count);
      reorderSplats(data);
      return data;
    });
  }
  function releaseSogChunk({ id }) {
    sogLoads.get(id)?.abort();
    sogChunks.delete(id);
  }
  return {
    loadSogChunk,
    cacheSogChunk,
    extractSogRegions,
    releaseSogChunk,
    parseSogIndex,
    releaseSogIndex,
    selectSogLod,
  };
}
