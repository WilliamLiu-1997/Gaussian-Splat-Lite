import { Box3, Vector3 } from "three";
import { packLodTree } from "../chunk-stream/lodTree.js";

function fail(message) {
  throw new Error(`LCC2: ${message}`);
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${name}`);
  return value;
}
function bounds(value) {
  for (const key of ["min", "max"])
    if (
      !Array.isArray(value?.[key]) ||
      value[key].length !== 3 ||
      !value[key].every(Number.isFinite)
    )
      fail("invalid bounding box");
  const box = new Box3(new Vector3(...value.min), new Vector3(...value.max));
  if (box.isEmpty()) fail("bounding box min exceeds max");
  return box;
}

/** LCC2 0.0.x stores one file range per node of an N-ary LOD tree. */
export function parseLcc2Index(value, baseUrl) {
  if (!/^0\.0\.\d+$/.test(value?.version))
    fail(`unsupported version ${value?.version}`);
  const levels = integer(value.totalLevels, "totalLevels");
  if (!levels) fail("totalLevels must be positive");
  const root = value.root;
  if (!Array.isArray(root?.splatFiles)) fail("missing root.splatFiles");
  const urls = root.splatFiles.map((name) => {
    if (typeof name !== "string" || !/\.(sog|spz|ply)$/i.test(name))
      fail("unsupported splat file");
    return new URL(name, baseUrl).href;
  });
  if (new Set(urls).size !== urls.length) fail("duplicate splat file");
  const environment =
    root.data?.env == null
      ? -1
      : integer(root.data.env.name, "environment file");
  if (environment >= urls.length) fail("environment file is out of bounds");
  const nodes = [];
  const counts = new Float64Array(urls.length);
  const ranges = urls.map(() => []);
  const rootBound = bounds(root.boundingBox);
  const childrenOf = (node) => {
    const children = node.child;
    if (children == null) return [];
    if (typeof children !== "object") fail("invalid children");
    return Object.values(children);
  };
  const visit = (node, parent, depth) => {
    if (depth > levels) fail("node depth exceeds totalLevels");
    const id = nodes.length;
    const entry = {
      parent,
      level: levels - depth,
      bound: bounds(node.boundingBox),
      file: -1,
      start: 0,
      count: 0,
      children: [],
    };
    nodes.push(entry);
    const data = node.data?.["3dgs"];
    if (data) {
      entry.count = integer(data.count, "splat count");
      entry.start = integer(data.start, "range start");
      const file = integer(data.name, "file index");
      if (file >= urls.length || file === environment)
        fail("invalid node file");
      const end = integer(entry.start + entry.count, "range end");
      if (entry.count) {
        entry.file = file;
        counts[file] = Math.max(counts[file], end);
        ranges[file].push(entry);
      }
    }
    for (const child of childrenOf(node)) {
      const next = visit(child, id, depth + 1);
      entry.children.push(next);
      entry.bound.union(nodes[next].bound);
    }
    return id;
  };
  const roots = [];
  for (const child of childrenOf(root)) {
    const id = visit(child, -1, 1);
    roots.push(id);
    rootBound.union(nodes[id].bound);
  }
  for (const file of ranges) {
    file.sort((a, b) => a.start - b.start);
    for (let i = 1; i < file.length; i++)
      if (file[i].start < file[i - 1].start + file[i - 1].count)
        fail("overlapping node ranges");
  }
  if (environment >= 0) counts[environment] = -1;
  return {
    ...packLodTree(nodes, roots, {
      bounds: rootBound,
      urls,
      counts,
    }),
    environment,
  };
}
