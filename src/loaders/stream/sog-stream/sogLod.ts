import { Box3, Vector3 } from "three";

export type SogLodRange = {
  leaf: number;
  level: number;
  file: number;
  offset: number;
  count: number;
};

export type SogLodLeaf = {
  id: number;
  /** Coarse to fine, with strictly increasing counts and decreasing levels. */
  lods: SogLodRange[];
};

export type SogLodNode = {
  bound: Box3;
  children?: SogLodNode[];
  leaf?: SogLodLeaf;
};

export type SogLodFile = {
  url: string;
  count: number;
  ranges: SogLodRange[];
};

export type SogLodManifest = {
  tree: SogLodNode;
  leaves: SogLodLeaf[];
  /** Flattened in leaf/LOD order; each leaf's first entry is unused. */
  upgradeRatios: number[];
  files: SogLodFile[];
  environment?: string;
};

export const SOG_LOD_STRIDE = 4;

const DISTANCE_BAND_MULTIPLIER = 1.5;

/** Packed worker index. Float64 preserves source bounds and safe-integer counts. */
export type SogLodIndex = {
  /** Preorder nodes: min XYZ, max XYZ, next index after the subtree, leaf ID (-1 for interiors). */
  nodes: Float64Array;
  leafOffsets: Uint32Array;
  /** Per level: level, file, offset, count. */
  lods: Float64Array;
  /** Best reachable distance-error reduction per added splat, in LOD order. */
  upgradeRatios: Float32Array;
  urls: string[];
  counts: Float64Array;
  environment?: string;
};

/** Scheduler metadata; the complete spatial tree stays in the LOD worker. */
export type SogLodMetadata = Omit<SogLodIndex, "nodes" | "upgradeRatios"> & {
  /** Root min XYZ and max XYZ. */
  bounds: Float64Array;
};

/** Flatten the tree and ranges into transferable typed arrays. */
export function packSogLodIndex(manifest: SogLodManifest): SogLodIndex {
  const { leaves, files, environment } = manifest;
  const nodes = new Float64Array((leaves.length * 2 - 1) * 8);
  let nextNode = 0;
  const writeNode = (node: SogLodNode) => {
    const offset = nextNode++ * 8;
    node.bound.min.toArray(nodes, offset);
    node.bound.max.toArray(nodes, offset + 3);
    nodes[offset + 7] = node.leaf?.id ?? -1;
    for (const child of node.children ?? []) writeNode(child);
    nodes[offset + 6] = nextNode;
  };
  writeNode(manifest.tree);
  const leafOffsets = new Uint32Array(leaves.length + 1);
  let count = 0;
  for (const leaf of leaves) {
    leafOffsets[leaf.id] = count;
    count += leaf.lods.length;
  }
  leafOffsets[leaves.length] = count;
  const lods = new Float64Array(count * SOG_LOD_STRIDE);
  for (const leaf of leaves) {
    leaf.lods.forEach((lod, index) => {
      lods.set(
        [lod.level, lod.file, lod.offset, lod.count],
        (leafOffsets[leaf.id] + index) * SOG_LOD_STRIDE,
      );
    });
  }
  return {
    nodes,
    leafOffsets,
    lods,
    upgradeRatios: Float32Array.from(manifest.upgradeRatios),
    urls: files.map((file) => file.url),
    counts: Float64Array.from(files, (file) => file.count),
    environment,
  };
}

/** Materialize only leaves visited by the camera, preserving stable range identities. */
export function readSogLodLeaf(
  index: Pick<SogLodIndex, "leafOffsets" | "lods">,
  id: number,
): SogLodLeaf {
  const leaf: SogLodLeaf = { id, lods: [] };
  const data = index.lods;
  for (let i = index.leafOffsets[id]; i < index.leafOffsets[id + 1]; i++) {
    const offset = i * SOG_LOD_STRIDE;
    leaf.lods.push({
      leaf: id,
      level: data[offset],
      file: data[offset + 1],
      offset: data[offset + 2],
      count: data[offset + 3],
    });
  }
  return leaf;
}

function fail(message: string): never {
  throw new Error(`Streamed SOG: ${message}`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("expected an object");
  return value as Record<string, unknown>;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`invalid ${name}`);
  return value;
}

function resolve(value: unknown, baseUrl: string): string {
  if (typeof value !== "string" || !value) fail("invalid asset path");
  return new URL(value, baseUrl).href;
}

/** Streamed SOG v1, including the earlier unversioned manifests. */
export function parseSogLodManifest(
  value: unknown,
  baseUrl: string,
): SogLodManifest {
  const root = object(value);
  if (root.version !== undefined && root.version !== 1)
    fail(`unsupported version ${root.version}`);
  const levels = integer(root.lodLevels, "lodLevels");
  if (levels < 1) fail("lodLevels must be positive");
  if (!Array.isArray(root.filenames)) fail("filenames must be an array");
  const files: SogLodFile[] = [];
  const urls = new Map<string, number>();
  const fileIndices = root.filenames.map((path) => {
    const url = resolve(path, baseUrl);
    const existing = urls.get(url);
    if (existing !== undefined) return existing;
    urls.set(url, files.length);
    files.push({ url, count: 0, ranges: [] });
    return files.length - 1;
  });
  const leaves: SogLodLeaf[] = [];
  const counts = Array<number>(levels).fill(0);
  const parseNode = (value: unknown): SogLodNode => {
    const node = object(value);
    const bounds = object(node.bound);
    const vector = (value: unknown) => {
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        !value.every(
          (item) => typeof item === "number" && Number.isFinite(item),
        )
      )
        fail("invalid bounding box");
      return new Vector3(value[0], value[1], value[2]);
    };
    const bound = new Box3(vector(bounds.min), vector(bounds.max));
    if (bound.isEmpty()) fail("bounding box min exceeds max");
    if (node.children !== undefined) {
      if (
        node.lods !== undefined ||
        !Array.isArray(node.children) ||
        node.children.length !== 2
      )
        fail("interior nodes must have exactly two children and no lods");
      const children = node.children.map(parseNode);
      // Include children despite rounding in older writers' parent bounds.
      for (const child of children) bound.union(child.bound);
      return { bound, children };
    }
    const leaf: SogLodLeaf = { id: leaves.length, lods: [] };
    leaves.push(leaf);
    for (const [key, value] of Object.entries(object(node.lods))) {
      const level = Number(key);
      if (
        !/^\d+$/.test(key) ||
        String(level) !== key ||
        !Number.isInteger(level) ||
        level >= levels
      )
        fail(`invalid LOD level ${key}`);
      const entry = object(value);
      const fileIndex = integer(entry.file, "file index");
      if (fileIndex >= fileIndices.length) fail("file index is out of bounds");
      const range: SogLodRange = {
        leaf: leaf.id,
        level,
        file: fileIndices[fileIndex],
        offset: integer(entry.offset, "splat offset"),
        count: integer(entry.count, "splat count"),
      };
      integer(range.offset + range.count, "range end");
      counts[level] += range.count;
      if (range.count > 0) {
        files[range.file].ranges.push(range);
        leaf.lods.push(range);
      }
    }
    return { bound, leaf };
  };
  const tree = parseNode(root.tree);
  const bandWeights = new Float64Array(levels);
  for (let level = 1; level < levels; level++)
    bandWeights[level] = DISTANCE_BAND_MULTIPLIER ** (2 * (level - 1));
  const distanceErrors = new Float64Array(levels);
  const upgradeRatios: number[] = [];
  for (const leaf of leaves) {
    // Include every nonempty level before pruning, even with equal or inverted counts.
    leaf.lods.sort((a, b) => b.level - a.level);
    let error = 0;
    for (let i = leaf.lods.length - 1; i >= 0; i--) {
      const lod = leaf.lods[i];
      const finer = leaf.lods[i + 1];
      if (finer)
        error += Math.max(finer.count - lod.count, 1) * bandWeights[lod.level];
      distanceErrors[lod.level] = error;
    }
    leaf.lods.sort(
      (a, b) =>
        a.count - b.count || distanceErrors[a.level] - distanceErrors[b.level],
    );
    let bestError = Number.POSITIVE_INFINITY;
    leaf.lods = leaf.lods.filter((lod) => {
      if (distanceErrors[lod.level] >= bestError) return false;
      bestError = distanceErrors[lod.level];
      return true;
    });
    // Include pruned levels' errors when finding the best reachable upgrade ratio.
    if (leaf.lods.length) upgradeRatios.push(0);
    for (let i = 1; i < leaf.lods.length; i++) {
      const coarse = leaf.lods[i - 1];
      let ratio = 0;
      for (let j = i; j < leaf.lods.length; j++) {
        const reach = leaf.lods[j];
        ratio = Math.max(
          ratio,
          (distanceErrors[coarse.level] - distanceErrors[reach.level]) /
            (reach.count - coarse.count),
        );
      }
      upgradeRatios.push(ratio);
    }
  }
  for (const file of files) {
    file.ranges.sort((a, b) => a.offset - b.offset || a.count - b.count);
    const level = file.ranges[0]?.level;
    for (const range of file.ranges) {
      if (range.offset !== file.count || range.level !== level)
        fail("chunk ranges must cover one LOD without gaps or overlaps");
      file.count += range.count;
    }
  }
  const count = counts.reduce((sum, value) => sum + value, 0);
  integer(count, "total count");
  if (root.count !== undefined && root.count !== count) fail("count mismatch");
  if (
    root.counts !== undefined &&
    (!Array.isArray(root.counts) ||
      root.counts.length !== levels ||
      root.counts.some((count, level) => count !== counts[level]))
  )
    fail("per-LOD counts mismatch");
  const environment =
    root.environment == null ? undefined : resolve(root.environment, baseUrl);
  if (environment && files.some((file) => file.url === environment))
    fail("environment must be separate from LOD chunks");
  return { tree, leaves, upgradeRatios, files, environment };
}

export type SogVisibleLeaf = { leaf: SogLodLeaf; weight: number };

/** Reuse cached refinements up to the target, then split gaps of four or more. */
export function resolveSogLod(
  leaf: SogLodLeaf,
  target: SogLodRange,
  current: SogLodRange | undefined,
  isLoaded: (range: SogLodRange) => boolean,
): {
  range: SogLodRange | undefined;
  load?: SogLodRange;
  /** Wait until range is attached before requesting the next LOD. */
  refinement?: boolean;
} {
  if (current === target || isLoaded(target)) return { range: target };

  const targetIndex = leaf.lods.indexOf(target);
  const currentIndex = current ? leaf.lods.indexOf(current) : -1;
  // Prefer the finest cached refinement without going beyond the target.
  let index = targetIndex - 1;
  while (index > currentIndex && !isLoaded(leaf.lods[index])) index--;
  const range = index > currentIndex ? leaf.lods[index] : current;
  if (!range) return { range, load: leaf.lods[0] };

  let load = target;
  if (range.level - target.level >= 4) {
    const midpoint = Math.floor((range.level + target.level) / 2);
    let nextIndex = index + 1;
    // Missing or dominated levels advance to the finer side of the midpoint.
    while (nextIndex < targetIndex && leaf.lods[nextIndex].level > midpoint)
      nextIndex++;
    load = leaf.lods[nextIndex];
  }
  return { range, load, refinement: true };
}

/** Distance bands within a splat budget, using a small heap. */
export function selectSogLods(
  visible: SogVisibleLeaf[],
  budget: number,
  manifest: Pick<SogLodIndex, "leafOffsets" | "upgradeRatios">,
): Map<number, SogLodRange> {
  const { leafOffsets, upgradeRatios } = manifest;
  let remaining = budget;
  type Upgrade = SogVisibleLeaf & { index: number; score: number };
  const selected = new Map<number, SogLodRange>();
  const heap: Upgrade[] = [];
  const better = (a: Upgrade, b: Upgrade) =>
    a.score > b.score || (a.score === b.score && a.leaf.id < b.leaf.id);
  const push = (item: Upgrade) => {
    let index = heap.length;
    heap.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!better(item, heap[parent])) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && better(heap[child + 1], heap[child]))
          child++;
        if (!better(heap[child], last)) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  const upgrade = (
    leaf: SogLodLeaf,
    weight: number,
    index: number,
    ceiling = Number.POSITIVE_INFINITY,
  ) => {
    if (index >= leaf.lods.length) return;
    // A later step can have a higher ratio; keep it at the priority that opened it.
    const score = Math.min(
      weight * upgradeRatios[leafOffsets[leaf.id] + index],
      ceiling,
    );
    push({ leaf, weight, index, score });
  };
  for (const { leaf, weight } of visible) {
    const coarse = leaf.lods[0];
    if (!coarse) continue;
    selected.set(leaf.id, coarse);
    remaining -= coarse.count;
    upgrade(leaf, weight, 1);
  }
  while (heap.length) {
    const { leaf, weight, index, score } = pop();
    const coarse = leaf.lods[index - 1];
    const fine = leaf.lods[index];
    // Stop at the first unaffordable upgrade; skipping it makes unrelated
    // cheaper regions flicker as the camera moves. Coverage remains the floor.
    if (fine.count - coarse.count > remaining) break;
    remaining -= fine.count - coarse.count;
    selected.set(leaf.id, fine);
    upgrade(leaf, weight, index + 1, score);
  }
  return selected;
}
