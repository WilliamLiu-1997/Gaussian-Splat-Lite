import { Box3, Vector3 } from "three";
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
    const lods = [];
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
        level,
        file: fileIndices[fileIndex],
        offset: integer(entry.offset, "splat offset"),
        count,
      };
      integer(range.offset + range.count, "range end");
      counts[level] += range.count;
      files[range.file].ranges.push(range);
      lods.push(range);
    }
    return { bound, lods };
  };
  const tree = parseNode(root.tree);
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
  return {
    tree,
    lodLevels: levels,
    files,
    environment,
    extra: root.extras,
  };
}
