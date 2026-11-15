import { Positions } from "../sog/positions.js";
import { splitBlocks } from "../sog/split.js";
import { IndexArray } from "./storage.js";

export function representativeBlockLimit(workspace) {
  workspace.settle();
  return Math.max(
    2,
    Math.min(262144, Math.floor((workspace.room * 0.4) / 512)),
  );
}

// Splits the current frontier, `nodes` with their centers in `positions`, or
// all splats without them, into working blocks. Returns the blocks' tree
// and, if it divides, the frontier in the blocks' order. Parents from
// earlier rounds remain in paged storage at their original IDs, as tree
// edges refer to those IDs.
export async function representativeBlocks(
  splats,
  nodes,
  positions,
  limit,
  threads,
) {
  const count = nodes?.length ?? splats.length;
  const root = { start: 0, count, quota: Math.ceil(count / 2) };
  if (count <= limit) return { root };
  const source = nodes
    ? {
        workspace: splats.workspace,
        length: count,
        positions: Positions.of(positions, count),
      }
    : splats;
  const order = await splitBlocks(source, root, limit, threads);
  if (!nodes) return { root, order };
  const ordered = new IndexArray(splats.workspace);
  const indices = new Uint32Array(4096);
  for (let base = 0; base < count; base += indices.length) {
    splats.workspace.check();
    const size = Math.min(indices.length, count - base);
    order.read(base, indices, size);
    for (let i = 0; i < size; i++) indices[i] = nodes.get(indices[i]);
    ordered.write(base, indices, size);
  }
  order.dispose();
  return { root, order: ordered };
}
