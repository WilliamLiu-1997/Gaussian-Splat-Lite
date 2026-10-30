import {
  SH_ARRAY_COUNTS,
  SH_KEYS,
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { extractSplatRange } from "../../../data/splatRange.js";
import { reorderSplats, restoreSplatOrder } from "../../morton.js";
import {
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
  const sources = [];
  let lodLevels = 0;
  function parseSogIndex({ bytes, baseUrl }) {
    const manifest = parseSogLodManifest(
      JSON.parse(new TextDecoder().decode(bytes)),
      baseUrl,
    );
    // Keep the environment so the scheduler can enable or skip it later.
    const environment = manifest.environment ? manifest.files.length : -1;
    if (environment >= 0)
      manifest.files.push({ url: manifest.environment, count: -1 });
    const index = packSogLodIndex(manifest);
    sources.push({ index, visibility: new SogVisibility(index), environment });
  }
  function initializeSogIndex() {
    const urls = [];
    const counts = [];
    const lods = [];
    const leafOffsets = [0];
    const sourceIndices = [];
    const sourceBounds = new Float64Array(sources.length * 6);
    const environments = new Int32Array(sources.length).fill(-1);
    let retainedIndexBytes = 0;
    sources.forEach(({ index, environment }, source) => {
      sourceBounds.set(index.bounds, source * 6);
      const fileBase = urls.length;
      const lodBase = lods.length / 4;
      for (const offset of index.leafOffsets.subarray(1))
        leafOffsets.push(lodBase + offset);
      for (let i = 0; i < index.lods.length; i += 4)
        lods.push(
          index.lods[i],
          index.lods[i + 1] < 0 ? -1 : fileBase + index.lods[i + 1],
          index.lods[i + 2],
          index.lods[i + 3],
        );
      for (const url of index.urls) urls.push(url);
      for (const count of index.counts) {
        counts.push(count);
        sourceIndices.push(source);
      }
      if (environment >= 0) environments[source] = fileBase + environment;
      lodLevels = Math.max(lodLevels, index.lodLevels);
      retainedIndexBytes +=
        index.bounds.byteLength +
        index.leafBounds.byteLength +
        index.leafOffsets.byteLength +
        index.lods.byteLength +
        index.counts.byteLength;
    });
    return {
      urls,
      counts: Float64Array.from(counts),
      leafOffsets: Uint32Array.from(leafOffsets),
      lods: Float64Array.from(lods),
      sourceIndices: Uint32Array.from(sourceIndices),
      sourceBounds,
      environments,
      retainedIndexBytes,
    };
  }
  function selectSogLod(request) {
    const regions = [];
    let leafBase = 0;
    sources.forEach(({ index, visibility }, source) => {
      const collected = visibility.collect({
        ...request,
        transform: request.sources[source].transform,
      });
      collected.forEach((region, local) => {
        region.leaf.id = leafBase + local;
        region.source = source;
        regions.push(region);
      });
      leafBase += index.leafOffsets.length - 1;
    });
    const targets = selectSogLods(regions, lodLevels, request);
    regions.sort((a, b) => a.distance - b.distance || a.leaf.id - b.leaf.id);
    // Transfer only [leaf ID, LOD ordinal] pairs in loading priority order.
    const result = new Uint32Array(targets.size * 2);
    let offset = 0;
    for (const { leaf } of regions) {
      const target = targets.get(leaf.id);
      if (!target) continue;
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
    initializeSogIndex,
    selectSogLod,
  };
}
