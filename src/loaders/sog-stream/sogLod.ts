import { Box3, Vector3 } from "three";

export type SogLodRange = {
  leaf: number;
  level: number;
  file: number;
  offset: number;
  count: number;
  error: number;
};

export type SogLodLeaf = {
  id: number;
  /** Non-dominated levels, ordered from cheapest to highest quality. */
  lods: SogLodRange[];
  upgradeRatios: number[];
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
  files: SogLodFile[];
  environment?: string;
};

/** Transferable index. Float64 preserves source bounds and safe-integer counts. */
export type SogLodIndex = {
  /** Preorder nodes: min XYZ, max XYZ, next index after the subtree, leaf ID (-1 for interiors). */
  nodes: Float64Array;
  leafOffsets: Uint32Array;
  /** Per level: level, file, offset, count, error, upgrade ratio. */
  lods: Float64Array;
  urls: string[];
  counts: Float64Array;
  environment?: string;
};

/** Runs in the worker; the main thread traverses this layout without rebuilding a tree. */
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
  const lods = new Float64Array(count * 6);
  for (const leaf of leaves) {
    leaf.lods.forEach((lod, index) => {
      lods.set(
        [
          lod.level,
          lod.file,
          lod.offset,
          lod.count,
          lod.error,
          leaf.upgradeRatios[index] ?? 0,
        ],
        (leafOffsets[leaf.id] + index) * 6,
      );
    });
  }
  return {
    nodes,
    leafOffsets,
    lods,
    urls: files.map((file) => file.url),
    counts: Float64Array.from(files, (file) => file.count),
    environment,
  };
}

/** Materialize only leaves visited by the camera, preserving stable range identities. */
export function readSogLodLeaf(index: SogLodIndex, id: number): SogLodLeaf {
  const leaf: SogLodLeaf = { id, lods: [], upgradeRatios: [] };
  const data = index.lods;
  for (let i = index.leafOffsets[id]; i < index.leafOffsets[id + 1]; i++) {
    const offset = i * 6;
    leaf.lods.push({
      leaf: id,
      level: data[offset],
      file: data[offset + 1],
      offset: data[offset + 2],
      count: data[offset + 3],
      error: data[offset + 4],
    });
    leaf.upgradeRatios.push(data[offset + 5]);
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
  let fileErrors = root.lodErrors === true;
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
    const leaf: SogLodLeaf = {
      id: leaves.length,
      lods: [],
      upgradeRatios: [],
    };
    leaves.push(leaf);
    const errors = root.lodErrors === true ? node.errors : undefined;
    for (const [key, value] of Object.entries(object(node.lods))) {
      const level = Number(key);
      if (
        !/^\d+$/.test(key) ||
        String(level) !== key ||
        !Number.isInteger(level) ||
        level >= levels
      )
        fail(`invalid LOD level ${key}`);
      if (leaf.lods.some((lod) => lod.level === level))
        fail("duplicate LOD level");
      const entry = object(value);
      const fileIndex = integer(entry.file, "file index");
      if (fileIndex >= fileIndices.length) fail("file index is out of bounds");
      const range: SogLodRange = {
        leaf: leaf.id,
        level,
        file: fileIndices[fileIndex],
        offset: integer(entry.offset, "splat offset"),
        count: integer(entry.count, "splat count"),
        error: 0,
      };
      integer(range.offset + range.count, "range end");
      counts[level] += range.count;
      files[range.file].ranges.push(range);
      if (range.count > 0) {
        const error = Array.isArray(errors) ? errors[level] : undefined;
        if (typeof error !== "number" || !Number.isFinite(error) || error < 0)
          fileErrors = false;
        else range.error = error;
        leaf.lods.push(range);
      }
    }
    return { bound, leaf };
  };
  const tree = parseNode(root.tree);
  for (const leaf of leaves) {
    // Match PlayCanvas: validate only renderable entries, and derive errors for
    // the whole asset if any are missing. Unused zero placeholders are valid.
    if (!fileErrors) {
      leaf.lods.sort((a, b) => a.level - b.level);
      const finest = leaf.lods[0]?.count ?? 0;
      let error = 0;
      for (const lod of leaf.lods) {
        error = Math.max(error, Math.log(finest / lod.count));
        lod.error = error;
      }
    }
    leaf.lods.sort((a, b) => a.count - b.count || a.error - b.error);
    let bestError = Number.POSITIVE_INFINITY;
    leaf.lods = leaf.lods.filter((lod) => {
      if (lod.error >= bestError) return false;
      bestError = lod.error;
      return true;
    });
    // Each step buys the next level, valued by the best improvement reachable
    // from its starting point. This keeps useful intermediate LODs available.
    leaf.upgradeRatios = leaf.lods
      .slice(0, -1)
      .map((coarse, index) =>
        Math.max(
          ...leaf.lods
            .slice(index + 1)
            .map(
              (fine) =>
                (coarse.error - fine.error) / (fine.count - coarse.count),
            ),
        ),
      );
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
  return { tree, leaves, files, environment };
}

export type SogVisibleLeaf = { leaf: SogLodLeaf; weight: number };

/** Keep the best available LOD up to the target and load toward it in steps. */
export function resolveSogLod(
  leaf: SogLodLeaf,
  target: SogLodRange,
  current: SogLodRange | undefined,
  isLoaded: (range: SogLodRange) => boolean,
): {
  range: SogLodRange | undefined;
  load?: SogLodRange;
  /** Wait until range is attached before loading the finer level. */
  refinement?: boolean;
} {
  const targetIndex = leaf.lods.indexOf(target);
  let index = targetIndex;
  while (
    index >= 0 &&
    current !== leaf.lods[index] &&
    !isLoaded(leaf.lods[index])
  )
    index--;
  if (index < 0) return { range: current, load: leaf.lods[0] };

  const range = leaf.lods[index];
  if (index === targetIndex) return { range };

  const midpoint = Math.floor((range.level + target.level) / 2);
  let nextIndex = index + 1;
  // Missing or dominated levels advance to the finer side of the midpoint.
  while (nextIndex < targetIndex && leaf.lods[nextIndex].level > midpoint)
    nextIndex++;
  return { range, load: leaf.lods[nextIndex], refinement: true };
}

/** PlayCanvas-style coverage × error removed / splats added, using a small heap. */
export function selectSogLods(
  visible: SogVisibleLeaf[],
  budget: number,
): Map<number, SogLodRange> {
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
    push({
      leaf,
      weight,
      index,
      score: Math.min(ceiling, weight * leaf.upgradeRatios[index - 1]),
    });
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
