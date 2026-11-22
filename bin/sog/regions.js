export { buildRegions } from "./split.js";

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
