import { Pool, WorkerGroup, clusterers, computers } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import { reorder } from "./reorder.js";
import { blockArrays, blockBytes, simplifyBlock } from "./simplify.js";
import { SH_DIMS, Splats } from "./splats.js";
import { splitBlocks } from "./split.js";

// The most a simplifying thread's heap may grow to, in MiB, counted for each
// thread besides the 32 MiB of clusterers(): 12 MiB before any block and a
// young generation of 8 MiB, measured. The planner's objects took 15 MiB of
// heap for a full block and 24 MiB for one of exact duplicates.
const HEAP_MB = 32;

// An internal working block has a quota of one. Reduce its children before
// loading their representatives into the same scratch arrays as a leaf.
function loadBlock(source, node, arrays, check) {
  const { records, sh, merged, mergedSh } = arrays;
  if (!node.children) {
    source.load(node.start, node.count, records, sh);
    return node.count;
  }

  const reduceChild = (child) => {
    const count = loadBlock(source, child, arrays, check);
    simplifyBlock({ count, target: 1, maxSh: source.maxSh, ...arrays }, check);
  };

  reduceChild(node.children[0]);
  const left = merged.slice(0, 16);
  const leftSh = mergedSh.map((band, i) => band.slice(0, SH_DIMS[i]));
  reduceChild(node.children[1]);

  records.set(left);
  records.set(merged.subarray(0, 16), 16);
  for (let i = 0; i < sh.length; i++) {
    const size = SH_DIMS[i];
    sh[i].set(leftSh[i]);
    sh[i].set(mergedSh[i].subarray(0, size), size);
  }
  return 2;
}

async function simplifyBlocks(source, root, limit, output, update) {
  const { workspace, maxSh } = source;
  const dims = SH_DIMS.slice(0, maxSh).reduce((a, b) => a + b, 0);
  const blocks = [];
  let rows = 0;
  let most = 0;
  let start = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.children && node.quota >= 2) {
      stack.push(node.children[1], node.children[0]);
      continue;
    }
    blocks.push({ node, start });
    start += node.quota;
    rows = Math.max(rows, Math.min(node.count, limit));
    most = Math.max(most, node.quota);
  }

  // Start large blocks first; their final positions are already fixed.
  blocks.sort((a, b) => b.node.count - a.node.count);
  const bytes = blockBytes(rows, most, dims);
  const threads =
    blocks.length > 1
      ? clusterers(workspace, bytes + HEAP_MB * 1024 ** 2, 0, blocks.length)
      : 0;
  if (!threads) {
    workspace.settle();
    workspace.expect(bytes);
  }
  const check = () => workspace.check();
  const group = new WorkerGroup(
    new URL("./simplify.js", import.meta.url),
    threads,
    { simplifier: true, cancelled: workspace.cancelled },
    undefined,
    "Voxel simplification",
    HEAP_MB,
  );
  let next = 0;
  try {
    let done = 0;
    await Promise.all(
      group.threads.map(async (thread) => {
        let worker = thread;
        const arrays = blockArrays(rows, most, maxSh);
        while (next < blocks.length) {
          check();
          const { node, start } = blocks[next++];
          const count = loadBlock(source, node, arrays, check);
          const job = { count, target: node.quota, maxSh, ...arrays };
          if (worker) {
            try {
              await group.request(worker, job);
            } catch (error) {
              if (error.code !== "ERR_WORKER_OUT_OF_MEMORY") throw error;
              worker = undefined;
            }
          }
          if (!worker) simplifyBlock(job, check);
          output.store(start, node.quota, arrays.merged, arrays.mergedSh);
          done += node.count;
          update(done);
        }
      }),
    );
  } finally {
    next = blocks.length;
    await group.close();
  }
  workspace.settle();
  workspace.expect(0);
}

async function reduce(source, target, context, update) {
  const { workspace, maxSh } = source;
  workspace.settle();
  const dims = SH_DIMS.slice(0, maxSh).reduce((a, b) => a + b, 0);
  const limit = Math.max(
    2,
    Math.min(262144, Math.floor((workspace.room * 0.4) / (512 + dims * 8))),
  );
  const root = { start: 0, count: source.length, quota: target };
  let order;
  const output = new Splats(workspace, maxSh);
  try {
    if (source.length > limit) {
      // No more threads split than will simplify the blocks: threads that
      // ended leave memory that the system does not take back, and it
      // counts against the threads that follow.
      const bytes = blockBytes(
        limit,
        Math.ceil((limit * target) / root.count),
        dims,
      );
      const most = computers(workspace, bytes + HEAP_MB * 1024 ** 2, 0, limit);
      order = await splitBlocks(source, root, limit, most);
      context.pool ??= new Pool(workspace, source.length);
      reorder(source, order, context.pool);
      order.dispose();
      order = undefined;
    }
    await simplifyBlocks(source, root, limit, output, update);
    if (output.length !== target)
      throw new Error("LOD count differs from its target");
    return output;
  } catch (error) {
    output.dispose();
    throw error;
  } finally {
    order?.dispose();
  }
}

export async function buildLevels(input, rootSplats, factor) {
  const levels = [input];
  const context = { pool: undefined };
  let total = input.length;
  try {
    while (levels.at(-1).length > rootSplats) {
      const source = levels.at(-1);
      const target = Math.max(
        1,
        Math.min(source.length - 1, Math.ceil(source.length / factor)),
      );
      if (total + target > 0xffffffff)
        throw new Error(
          "Combined LODs exceed u32 index limit; increase --lod-factor",
        );
      const progress = new Progress(
        `Simplifying LOD ${levels.length} (${source.length} → ${target})`,
        source.length,
      );
      const next = await reduce(source, target, context, (done) =>
        progress.update(done),
      );
      levels.push(next);
      total += next.length;
      progress.finish(`${next.length} splats`);
    }
    console.log(
      `LOD counts: ${levels.map((level) => level.length).join(" → ")}`,
    );
    return levels;
  } catch (error) {
    for (const level of levels.slice(1)) level.dispose();
    throw error;
  } finally {
    await context.pool?.close();
  }
}
