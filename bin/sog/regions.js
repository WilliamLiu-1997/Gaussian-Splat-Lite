import { splitRegions } from "./split.js";

export class Levels {
  constructor(levels) {
    this.levels = levels;
    this.starts = [];
    this.length = 0;
    this.workspace = levels[0].workspace;
    for (const level of levels) {
      this.starts.push(this.length);
      this.length += level.length;
    }
  }
}

// Divides the splats of all levels into regions of at most `limit`. Returns
// the tree, its leaves, and `order`: level by level, each leaf's rows in
// Morton order, indexed within their level. A leaf's `lods` gives their
// place in `order`. A leaf's box holds only its splats' centers until
// writeScene() has measured the splats of its chunks.
export async function buildRegions(rows, limit) {
  const root = { start: 0, count: rows.length };
  const order = await splitRegions(rows, root, limit);
  const leaves = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.children) {
      stack.push(node.children[1], node.children[0]);
      continue;
    }
    leaves.push(node);
  }
  return { root, leaves, order };
}

export function finishTree(root) {
  const stack = [root];
  const nodes = [];
  while (stack.length) {
    const node = stack.pop();
    nodes.push(node);
    if (node.children) stack.push(...node.children);
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.children)
      for (const child of node.children)
        for (let d = 0; d < 3; d++) {
          node.bound.min[d] = Math.min(node.bound.min[d], child.bound.min[d]);
          node.bound.max[d] = Math.max(node.bound.max[d], child.bound.max[d]);
        }
    node.start = undefined;
    node.count = undefined;
  }
  return root;
}
