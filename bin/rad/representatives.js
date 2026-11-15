import { sortSplats } from "./heap.js";
import { WorkerGroup, computers } from "./parallel.js";
import { Progress } from "./progress.js";
import {
  representativeBlockLimit,
  representativeBlocks,
} from "./representative-blocks.js";
import {
  computeRepresentatives,
  representativeInputs,
  representativeJobBytes,
  representativeResults,
} from "./representative-job.js";
import { blendSh } from "./representative-sh.js";
import {
  RepresentativeStore,
  loadRepresentativeBlock,
} from "./representative-store.js";
import { IndexArray, PagedArray, collect } from "./storage.js";

// Merges the blocks under `root` of the frontier `nodes`, all splats in
// their order without it. Returns the next frontier, and its centers if
// `limit` will divide it.
async function reduce(splats, nodes, root, limit, round) {
  const { workspace } = splats;
  const blocks = [];
  const pending = [root];
  let count = 0;
  let target = 0;
  while (pending.length) {
    const node = pending.pop();
    if (node.children && node.quota >= 2) {
      pending.push(node.children[1], node.children[0]);
      continue;
    }
    blocks.push(node);
    count = Math.max(count, node.count);
    target = Math.max(target, node.quota);
  }
  workspace.settle();
  const bytes = representativeJobBytes(count, target);
  // The cache keeps a quarter of the room: blocks read their records in
  // order. A single worker adds no parallelism over the local path.
  const available =
    blocks.length > 1
      ? computers(
          workspace,
          bytes,
          Math.floor(workspace.room / 4),
          blocks.length,
        )
      : 0;
  const threads = available > 1 ? available : 0;
  workspace.expect(
    Math.max(1, threads) * (bytes + (threads ? 32 * 1024 ** 2 : 0)),
  );
  const next = new IndexArray(workspace);
  const positions =
    root.quota > limit ? new PagedArray(workspace, Float32Array) : undefined;
  const store = new RepresentativeStore(splats, count, target);
  const detail = threads ? `${threads} workers` : "";
  const progress = new Progress(
    `Merging representative level ${round}`,
    root.count,
    detail,
  );
  let done = 0;
  const commit = (block, results) => {
    store.append(results, block.quota, next, positions);
    done += block.count;
    progress.update(done, detail);
  };
  if (!threads) {
    const inputs = representativeInputs(count, target);
    const results = representativeResults(count, target);
    const check = () => workspace.check();
    for (const block of blocks) {
      loadRepresentativeBlock(splats, nodes, block, inputs, results);
      computeRepresentatives(
        { inputs, results, count: block.count, target: block.quota },
        check,
      );
      collect();
      commit(block, results);
    }
  } else {
    const group = new WorkerGroup(
      new URL("./representative-job.js", import.meta.url),
      threads,
      { representative: true, cancelled: workspace.cancelled },
      undefined,
      "RAD representatives",
    );
    try {
      // Workers take the blocks in order as they finish. A block's results
      // wait for the blocks before it, so commits follow the blocks' order
      // whichever finishes first; with twice as many results as workers,
      // the workers rarely wait for a slow block.
      const idle = group.workers.map((worker) => ({
        worker,
        inputs: representativeInputs(count, target),
      }));
      const spare = Array.from({ length: threads * 2 }, () =>
        representativeResults(count, target),
      );
      const finished = new Map();
      let started = 0;
      let committed = 0;
      await new Promise((resolve, reject) => {
        const start = () => {
          while (idle.length && spare.length && started < blocks.length) {
            const slot = idle.pop();
            const results = spare.pop();
            const index = started++;
            const block = blocks[index];
            loadRepresentativeBlock(splats, nodes, block, slot.inputs, results);
            group
              .request(slot.worker, {
                inputs: slot.inputs,
                results,
                count: block.count,
                target: block.quota,
              })
              .then(() => {
                idle.push(slot);
                finished.set(index, results);
                while (finished.has(committed)) {
                  const ready = finished.get(committed);
                  finished.delete(committed);
                  commit(blocks[committed++], ready);
                  spare.push(ready);
                }
                if (committed === blocks.length) resolve();
                else start();
              })
              .catch(reject);
          }
        };
        start();
      });
    } finally {
      await group.close();
    }
  }
  if (next.length !== root.quota)
    throw new Error("Representative level missed its target count");
  progress.finish(`${root.count} -> ${next.length} splats`);
  return { next, positions };
}

export async function mergeRepresentatives(splats, pool) {
  const { workspace } = splats;
  const initial = splats.length;
  const limit = representativeBlockLimit(workspace);
  if (splats.length > limit)
    console.log(`Representative working blocks: up to ${limit} splats`);
  const threads = Math.max(1, pool.workers.length);
  let { root, order } = await representativeBlocks(
    splats,
    undefined,
    undefined,
    limit,
    threads,
  );
  // Lay out leaves spatially once, before any tree edges exist, so that
  // each block's records are read in order.
  if (order) splats.reorder(order, pool);
  else sortSplats(splats, pool);
  // The frontier: all splats in their order at first, then each round's
  // results, with their centers while blocks divide them.
  let nodes;
  for (let round = 1; root.count > 1; round++) {
    const { next, positions } = await reduce(splats, nodes, root, limit, round);
    nodes?.dispose();
    nodes = next;
    ({ root, order } = await representativeBlocks(
      splats,
      nodes,
      positions,
      limit,
      threads,
    ));
    if (order) {
      nodes.dispose();
      nodes = order;
    }
  }
  nodes?.dispose();
  workspace.settle();
  workspace.expect(0);
  blendSh(splats, initial, pool);
}
