/** Pack parent-before-child nodes with one file range per LOD node. */
export function packLodTree(nodes, roots, { bounds, urls, counts }) {
  const n = nodes.length;
  const nodeBounds = new Float64Array(n * 6);
  const ranges = new Float64Array(n * 4);
  const parents = new Int32Array(n);
  const emptyCoverage = new Uint8Array(n);
  const childOffsets = new Uint32Array(n + 1);
  const children = [];
  for (let id = n - 1; id >= 0; id--) {
    const node = nodes[id];
    emptyCoverage[id] =
      !node.count ||
      (node.children.length > 0 &&
        node.children.every((child) => emptyCoverage[child]));
  }
  nodes.forEach((node, id) => {
    node.bound.min.toArray(nodeBounds, id * 6);
    node.bound.max.toArray(nodeBounds, id * 6 + 3);
    ranges.set([node.level, node.file, node.start, node.count], id * 4);
    parents[id] = node.parent;
    childOffsets[id] = children.length;
    for (const child of node.children) children.push(child);
  });
  childOffsets[n] = children.length;
  return {
    bounds: Float64Array.from([
      ...bounds.min.toArray(),
      ...bounds.max.toArray(),
    ]),
    nodeBounds,
    ranges,
    urls,
    counts,
    parents,
    emptyCoverage,
    roots: Uint32Array.from(roots),
    childOffsets,
    children: Uint32Array.from(children),
  };
}
