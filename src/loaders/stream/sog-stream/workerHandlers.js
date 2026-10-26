import { Box3 } from "three";
import {
  SH_ARRAY_COUNTS,
  SH_KEYS,
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
  const manifests = [];
  let visibility;
  function parseSogIndex({ bytes, baseUrl, environment }) {
    const manifest = parseSogLodManifest(
      JSON.parse(new TextDecoder().decode(bytes)),
      baseUrl,
    );
    if (environment === false) manifest.environment = undefined;
    manifests.push(manifest);
  }
  function initializeSogIndex() {
    const tree = { bound: new Box3(), children: [] };
    const leaves = [];
    const files = [];
    const sourceIndices = [];
    const environments = [];
    let levels = 0;
    manifests.splice(0).forEach((manifest, source) => {
      const leafBase = leaves.length;
      const fileBase = files.length;
      for (const leaf of manifest.leaves) {
        leaf.id += leafBase;
        for (const range of leaf.lods)
          if (range.file >= 0) range.file += fileBase;
        leaves.push(leaf);
      }
      for (const file of manifest.files) {
        files.push(file);
        sourceIndices.push(source);
      }
      if (manifest.environment) {
        environments.push(files.length);
        files.push({ url: manifest.environment, count: -1 });
        sourceIndices.push(source);
      }
      tree.children.push(manifest.tree);
      tree.bound.union(manifest.tree.bound);
      levels = Math.max(levels, manifest.lodLevels);
    });
    const index = packSogLodIndex({ tree, leaves, files, lodLevels: levels });
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
      sourceIndices: Uint32Array.from(sourceIndices),
      environments: Uint32Array.from(environments),
      leafOffsets: leafOffsets.slice(),
      lods: lods.slice(),
      retainedIndexBytes:
        leafBounds.byteLength + leafOffsets.byteLength + lods.byteLength,
    };
  }
  function selectSogLod(request) {
    return visibility.select(request);
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
