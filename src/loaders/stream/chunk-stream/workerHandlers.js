import { sogBatchAllocationSize } from "../../../data/SogRegionSplats.js";
import { truncateShPalette } from "../../../data/shPaletteData.js";
import {
  SH_ARRAY_COUNTS,
  SH_KEYS,
  getSplatByteLength,
  getSplatShDegree,
} from "../../../data/splatData.js";
import { extractSplatRange } from "../../../data/splatRange.js";
import { reorderSplats, restoreSplatOrder } from "../../morton.js";
import { parseLcc2Index } from "../lcc2-stream/lcc2Index.js";
import { selectLcc2Lods } from "../lcc2-stream/lcc2Select.js";
import {
  SOG_LOD_STRIDE,
  packSogLodIndex,
  parseSogLodManifest,
  selectSogLods,
} from "../sog-stream/sogLod.js";
import { SogVisibility } from "../sog-stream/sogVisibility.js";
/** LOD workers parse the index once before selection; other workers own chunk caches. */
export function createChunkStreamHandlers(decodeSplats) {
  const chunks = new Map();
  const loads = new Map();
  // Each input keeps its own bounds and median region size for LOD distance.
  const sources = new Map();
  let nextLeaf = 0;
  let nextFile = 0;
  function parseIndex({ id, bytes, baseUrl, format = "sog" }) {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    let index;
    let environment;
    let extra;
    if (format === "lcc2") {
      index = parseLcc2Index(value, baseUrl);
      environment = index.environment;
    } else {
      const manifest = parseSogLodManifest(value, baseUrl);
      extra = manifest.extra;
      environment = manifest.environment ? manifest.files.length : -1;
      if (environment >= 0)
        manifest.files.push({ url: manifest.environment, count: -1 });
      index = packSogLodIndex(manifest);
    }
    const leafBase = nextLeaf;
    const fileBase = nextFile;
    // IDs are never reused, including after removal. Selection uses uint32 IDs.
    const leafEnd = leafBase + index.leafOffsets.length - 1;
    const fileEnd = fileBase + index.urls.length;
    if (leafEnd > 0x100000000 || !Number.isSafeInteger(fileEnd))
      throw new Error("Streaming index capacity exceeded");
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
      hasData: index.lods.some((count, i) => i % 4 === 3 && count > 0),
      extra,
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
      ...(index.parents
        ? {
            parents: index.parents.slice(),
            emptyCoverage: index.emptyCoverage.slice(),
            roots: index.roots.slice(),
            childOffsets: index.childOffsets.slice(),
            children: index.children.slice(),
          }
        : {}),
      retainedIndexBytes:
        index.bounds.byteLength +
        index.leafBounds.byteLength +
        index.leafOffsets.byteLength +
        index.lods.byteLength +
        index.counts.byteLength +
        (index.parents?.byteLength ?? 0) +
        (index.emptyCoverage?.byteLength ?? 0) +
        (index.roots?.byteLength ?? 0) +
        (index.childOffsets?.byteLength ?? 0) +
        (index.children?.byteLength ?? 0),
    };
  }
  function releaseIndex({ id }) {
    sources.delete(id);
  }
  function selectLod(request) {
    if (request.format === "lcc2")
      return selectLcc2Lods(
        request.sources.map(({ id }) => sources.get(id)),
        request,
      );
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
  function cacheChunk({ id, data, maxSh, blindData = true }) {
    // Custom loaders may return Blind data this scheduler skips.
    if (!blindData) data.extra.blind = undefined;
    // Custom loaders may return higher SH than this scheduler retains.
    for (const key of SH_KEYS.slice(SH_ARRAY_COUNTS[maxSh]))
      delete data.extra[key];
    if (data.extra.shDegree && data.extra.shDegree > maxSh) {
      if (maxSh) {
        data.extra.shPalette = truncateShPalette(
          data.extra.shPalette,
          data.extra.shDegree,
          maxSh,
        );
        data.extra.shDegree = maxSh;
      } else {
        data.extra.shLabels = undefined;
        data.extra.shPalette = undefined;
        data.extra.shDegree = undefined;
      }
    }
    // A custom loader may have reordered the whole chunk. Restore file ranges
    // once; each extracted region is reordered independently below.
    restoreSplatOrder(data);
    const { shPalette, extra } = data.extra;
    data.extra.shPalette = undefined;
    data.extra.extra = undefined;
    chunks.set(id, data);
    return {
      numSplats: data.numSplats,
      numSh: getSplatShDegree(data.extra),
      byteLength: getSplatByteLength(data),
      extra,
      shPalette,
      shDegree: data.extra.shDegree,
      blindTextureCount: data.extra.blind?.length ?? 0,
    };
  }
  async function loadChunk({ id, ...args }, options) {
    const controller = new AbortController();
    loads.set(id, controller);
    try {
      const data = await decodeSplats(
        { ...args, signal: controller.signal },
        options,
      );
      controller.signal.throwIfAborted();
      return cacheChunk({ id, data, maxSh: args.maxSh });
    } finally {
      loads.delete(id);
    }
  }
  function extractRegions({ id, ranges }) {
    const source = chunks.get(id);
    if (!source) throw new Error("Streaming chunk is no longer cached");
    // Fixed batch storage supplies alignment and reads centers from packed XYZ.
    return ranges.map(({ start, count }) => {
      const data = extractSplatRange(source, start, count);
      reorderSplats(data);
      return data;
    });
  }
  function releaseChunk({ id }) {
    loads.get(id)?.abort();
    chunks.delete(id);
  }
  return {
    loadChunk,
    cacheChunk,
    extractRegions,
    releaseChunk,
    parseIndex,
    releaseIndex,
    selectLod,
  };
}
