import { Box3 } from "three";
import { packLodTree } from "../chunk-stream/lodTree.js";

const NODE_SPLATS = 4096;

/** Promote contiguous ranges to spatial ancestors, as in PlayCanvas's SOG LOD tree. */
export function buildSogLodTree(manifest) {
  const { lodLevels, files } = manifest;
  const read = (node) => {
    const ranges = Array(lodLevels);
    const children = node.children?.map(read) ?? [];
    const bound = children.length ? new Box3() : node.bound;
    if (node.lods) {
      for (const range of node.lods) ranges[range.level] = range;
    } else {
      for (const child of children) bound.union(child.bound);
      for (let level = 0; level < lodLevels; level++) {
        const parts = children
          .map((child) => child.ranges[level])
          .filter(Boolean)
          .sort((a, b) => a.offset - b.offset);
        if (!parts.length) continue;
        let { file, offset } = parts[0];
        let count = 0;
        for (const part of parts) {
          if (part.file !== file || part.offset !== offset + count) file = -1;
          count += part.count;
        }
        ranges[level] = { file, offset, count };
      }
    }
    let finest = lodLevels;
    for (let level = lodLevels - 1; level >= 0; level--) {
      const range = ranges[level];
      if (range && (range.count > NODE_SPLATS || range.file < 0)) break;
      finest = level;
    }
    return { bound, ranges, children, finest };
  };
  const root = read(manifest.tree);
  const nodes = [];
  const emit = (entry, coarsest, parent) => {
    if (coarsest < 0) return [];
    const finest = entry.children.length
      ? Math.min(entry.finest, coarsest + 1)
      : 0;
    const roots = [];
    let last = parent;
    for (let level = coarsest; level >= finest; level--) {
      const range = entry.ranges[level];
      const id = nodes.length;
      nodes.push({
        parent: last,
        bound: entry.bound,
        level,
        file: range?.file ?? -1,
        start: range?.offset ?? 0,
        count: range?.count ?? 0,
        children: [],
      });
      if (level === coarsest) roots.push(id);
      else nodes[last].children.push(id);
      last = id;
    }
    for (const child of entry.children) {
      const below = emit(child, finest - 1, last);
      if (finest <= coarsest) {
        for (const id of below) nodes[last].children.push(id);
      } else {
        for (const id of below) roots.push(id);
      }
    }
    return roots;
  };
  const roots = emit(root, lodLevels - 1, -1);
  return packLodTree(nodes, roots, {
    bounds: root.bound,
    urls: files.map((file) => file.url),
    counts: Float64Array.from(files, (file) => file.count),
  });
}
