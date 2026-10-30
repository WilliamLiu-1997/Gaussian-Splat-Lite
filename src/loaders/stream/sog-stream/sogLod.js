import { Box3, Vector3 } from "three";
export const SOG_LOD_STRIDE = 4;
/** Pack region bounds and ranges into transferable typed arrays. */
export function packSogLodIndex(manifest) {
  const { tree, leaves, files } = manifest;
  // Float64 preserves source bounds and safe-integer counts in the worker index.
  const bounds = new Float64Array(6);
  tree.bound.min.toArray(bounds);
  tree.bound.max.toArray(bounds, 3);
  const leafBounds = new Float64Array(leaves.length * 6);
  const writeLeafBounds = (node) => {
    if (node.leaf) {
      const offset = node.leaf.id * 6;
      node.bound.min.toArray(leafBounds, offset);
      node.bound.max.toArray(leafBounds, offset + 3);
    } else {
      for (const child of node.children) writeLeafBounds(child);
    }
  };
  writeLeafBounds(tree);
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
    bounds,
    leafBounds,
    leafOffsets,
    lods,
    lodLevels: manifest.lodLevels,
    urls: files.map((file) => file.url),
    counts: Float64Array.from(files, (file) => file.count),
  };
}
/** Materialize only leaves visited by the camera, preserving stable range identities. */
export function readSogLodLeaf(index, id) {
  const leaf = { id, lods: [] };
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
function fail(message) {
  throw new Error(`Streamed SOG: ${message}`);
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("expected an object");
  return value;
}
function integer(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`invalid ${name}`);
  return value;
}
function resolve(value, baseUrl) {
  if (typeof value !== "string" || !value) fail("invalid asset path");
  return new URL(value, baseUrl).href;
}
/** Streamed SOG v1, including the earlier unversioned manifests. */
export function parseSogLodManifest(value, baseUrl) {
  const root = object(value);
  if (root.version !== undefined && root.version !== 1)
    fail(`unsupported version ${root.version}`);
  const levels = integer(root.lodLevels, "lodLevels");
  if (levels < 1) fail("lodLevels must be positive");
  if (!Array.isArray(root.filenames)) fail("filenames must be an array");
  const files = [];
  const urls = new Map();
  const fileIndices = root.filenames.map((path) => {
    const url = resolve(path, baseUrl);
    const existing = urls.get(url);
    if (existing !== undefined) return existing;
    urls.set(url, files.length);
    files.push({ url, count: 0, ranges: [] });
    return files.length - 1;
  });
  const leaves = [];
  const counts = Array(levels).fill(0);
  const parseNode = (value) => {
    const node = object(value);
    const bounds = object(node.bound);
    const vector = (value) => {
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        !value.every(Number.isFinite)
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
    const leaf = { id: leaves.length, lods: [] };
    leaves.push(leaf);
    for (const [key, value] of Object.entries(object(node.lods))) {
      const level = Number(key);
      if (!/^\d+$/.test(key) || String(level) !== key || level >= levels)
        fail(`invalid LOD level ${key}`);
      const entry = object(value);
      const count = integer(entry.count, "splat count");
      if (count === 0) continue;
      const fileIndex = integer(entry.file, "file index");
      if (fileIndex >= fileIndices.length) fail("file index is out of bounds");
      const range = {
        leaf: leaf.id,
        level,
        file: fileIndices[fileIndex],
        offset: integer(entry.offset, "splat offset"),
        count,
      };
      integer(range.offset + range.count, "range end");
      counts[level] += range.count;
      files[range.file].ranges.push(range);
      leaf.lods.push(range);
    }
    return { bound, leaf };
  };
  const tree = parseNode(root.tree);
  for (const leaf of leaves) {
    // Keep every populated level: distance bands choose detail by level, not cost.
    leaf.lods.sort((a, b) => b.level - a.level);
    const coarsest = leaf.lods[0];
    // Missing coarser data means this region was decimated away. Its coarser
    // bands stay empty until the camera reaches its first populated level.
    if (coarsest && coarsest.level < levels - 1) {
      leaf.lods.unshift({
        leaf: leaf.id,
        level: coarsest.level + 1,
        file: -1,
        offset: 0,
        count: 0,
      });
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
  return { tree, leaves, lodLevels: levels, files, environment };
}
/** Reuse cached refinements up to the target, then split gaps of four or more. */
export function resolveSogLod(leaf, target, current, isLoaded) {
  if (target.count === 0) return { range: undefined };
  if (current === target || isLoaded(target)) return { range: target };
  const targetIndex = leaf.lods.indexOf(target);
  const currentIndex = current ? leaf.lods.indexOf(current) : -1;
  // Prefer the finest cached refinement without going beyond the target.
  let index = targetIndex - 1;
  while (
    index > currentIndex &&
    (leaf.lods[index].count === 0 || !isLoaded(leaf.lods[index]))
  )
    index--;
  const range = index > currentIndex ? leaf.lods[index] : current;
  if (!range) return { range, load: leaf.lods.find((lod) => lod.count > 0) };
  let load = target;
  if (range.level - target.level >= 4) {
    const midpoint = Math.floor((range.level + target.level) / 2);
    let nextIndex = index + 1;
    // Missing levels advance to the finer side of the midpoint.
    while (nextIndex < targetIndex && leaf.lods[nextIndex].level > midpoint)
      nextIndex++;
    load = leaf.lods[nextIndex];
  }
  return { range, load, refinement: true };
}
/** Fit each input's distance bands to the budget with one shared scale. */
export function selectSogLods(
  visible,
  lodLevels,
  { budget, splatBudgetMode, sources },
) {
  const limit = splatBudgetMode === "limit";
  const bandDistances = sources.map(({ lodBaseDistance, lodMultiplier }) => {
    const bands = new Float64Array(lodLevels);
    for (let level = 1; level < bands.length; level++)
      bands[level] = lodBaseDistance * lodMultiplier ** (level - 1);
    return bands;
  });
  const selected = new Map();
  let total = 0;
  // Limit mode uses the configured bands directly when they fit. Target mode
  // can use every finest level when the whole visible scene fits.
  for (const { leaf, distance, source } of visible) {
    if (!leaf.lods.length) continue;
    let index = limit ? 0 : leaf.lods.length - 1;
    while (
      index < leaf.lods.length - 1 &&
      distance < bandDistances[source][leaf.lods[index].level]
    )
      index++;
    const target = leaf.lods[index];
    selected.set(leaf.id, target);
    total += target.count;
  }
  if (total <= budget) return selected;

  // Each transition gives the shared scale at which a region switches finer.
  // Per-input base distances and multipliers retain their relative influence.
  selected.clear();
  let remaining = budget;
  const heap = [];
  const better = (a, b) =>
    a.scale < b.scale || (a.scale === b.scale && a.leaf.id < b.leaf.id);
  const enqueue = (leaf, distance, source, index) => {
    if (index >= leaf.lods.length) return;
    // A missing intermediate band resolves to the next finer populated level.
    const band = bandDistances[source][leaf.lods[index - 1].level];
    if (limit && distance >= band) return;
    const item = { leaf, distance, source, index, scale: distance / band };
    let slot = heap.length;
    heap.push(item);
    while (slot > 0) {
      const parent = (slot - 1) >> 1;
      if (!better(item, heap[parent])) break;
      heap[slot] = heap[parent];
      slot = parent;
    }
    heap[slot] = item;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
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
  for (const { leaf, distance, source } of visible) {
    const coarse = leaf.lods[0];
    if (!coarse) continue;
    selected.set(leaf.id, coarse);
    remaining -= coarse.count;
    enqueue(leaf, distance, source, 1);
  }
  if (remaining <= 0) return selected;
  const transitions = [];
  while (heap.length) {
    const scale = heap[0].scale;
    transitions.length = 0;
    let cost = 0;
    do {
      const item = pop();
      const { leaf, distance, source, index } = item;
      cost += leaf.lods[index].count - leaf.lods[index - 1].count;
      transitions.push(item);
      enqueue(leaf, distance, source, index + 1);
    } while (heap.length && heap[0].scale === scale);
    // Equal-scale transitions move together, including collapsed bands at
    // multiplier 1. Stop at the first group that cannot fit to avoid flicker.
    if (cost > remaining) break;
    remaining -= cost;
    for (const { leaf, index } of transitions)
      selected.set(leaf.id, leaf.lods[index]);
  }
  return selected;
}
