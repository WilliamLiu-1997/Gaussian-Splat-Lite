import {
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { extractSplatRange } from "../../../data/splatRange.js";
import { reorderSplats, restoreSplatOrder } from "../../morton.js";
import { packSogLodIndex, parseSogLodManifest } from "./sogLod.js";
import { SogVisibility } from "./sogVisibility.js";
/** LOD workers parse the index once before selection; other workers own chunk caches. */
export function createSogStreamHandlers(decodeSplats) {
  const sogChunks = new Map();
  const sogLoads = new Map();
  let visibility;
  function parseSogIndex({ bytes, baseUrl }) {
    const index = packSogLodIndex(
      parseSogLodManifest(JSON.parse(new TextDecoder().decode(bytes)), baseUrl),
    );
    const { leafBounds, leafOffsets, lods, lodLevels, ...metadata } = index;
    visibility = new SogVisibility({
      leafBounds,
      leafOffsets,
      lods,
      lodLevels,
    });
    // Keep region bounds here; copy shared arrays before RPC transfers them.
    return {
      ...metadata,
      leafOffsets: leafOffsets.slice(),
      lods: lods.slice(),
      retainedIndexBytes:
        leafBounds.byteLength + leafOffsets.byteLength + lods.byteLength,
    };
  }
  function selectSogLod(request) {
    return visibility.select(request);
  }
  function cacheSogChunk({ id, data }) {
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
      return cacheSogChunk({ id, data });
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
    selectSogLod,
  };
}
