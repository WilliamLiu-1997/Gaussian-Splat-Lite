import { Box3, Vector3 } from "three";

export function getSogFrameBounds(tree) {
  const leaves = [];
  const visit = (node) => {
    if (node.children) {
      for (const child of node.children) visit(child);
    } else {
      const weight = Math.max(
        ...Object.values(node.lods).map((lod) => lod.count),
      );
      if (weight > 0) leaves.push({ bound: node.bound, weight });
    }
  };
  visit(tree);
  return getFrameBounds(leaves);
}

export function getLcc2FrameBounds(root) {
  const leaves = [];
  const visit = (node) => {
    const children = Object.values(node.child ?? {});
    if (children.length) {
      for (const child of children) visit(child);
    } else {
      const weight = node.data?.["3dgs"]?.count ?? 0;
      if (weight > 0) leaves.push({ bound: node.boundingBox, weight });
    }
  };
  for (const child of Object.values(root.child ?? {})) visit(child);
  return getFrameBounds(leaves);
}

function getFrameBounds(leaves) {
  if (!leaves.length) return new Box3();

  const total = leaves.reduce((sum, leaf) => sum + leaf.weight, 0);
  const percentile = (side, axis, fraction) => {
    leaves.sort((a, b) => a.bound[side][axis] - b.bound[side][axis]);
    let accumulated = 0;
    for (const leaf of leaves) {
      accumulated += leaf.weight;
      if (accumulated >= total * fraction) return leaf.bound[side][axis];
    }
  };

  // Framing ignores sparse tails; the source bounds and rendered points stay intact.
  return new Box3(
    new Vector3(...[0, 1, 2].map((axis) => percentile("min", axis, 0.01))),
    new Vector3(...[0, 1, 2].map((axis) => percentile("max", axis, 0.99))),
  );
}
