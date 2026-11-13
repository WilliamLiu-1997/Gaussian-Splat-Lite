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

// Simplifies the working blocks under `root` into `output`. A block depends
// on no other block and yields exactly its quota, so its splats have their
// place in the output beforehand: worker threads simplify blocks in any
// order while this thread reads and writes them, and the output is the same
// with any number of threads.
async function simplifyBlocks(source, root, limit, output, progress) {
  const { workspace, maxSh } = source;
  const dims = SH_DIMS.slice(0, maxSh).reduce((a, b) => a + b, 0);
  const blocks = [];
  let rows = 0;
  let most = 0;
  let offset = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.children && node.quota >= 2) {
      stack.push(node.children[1], node.children[0]);
      continue;
    }
    blocks.push({ node, offset });
    rows = Math.max(rows, Math.min(node.count, limit));
    most = Math.max(most, node.quota);
    offset += node.quota;
  }
  // The largest blocks go first, so that the last to finish are small and
  // few threads wait for them.
  blocks.sort((a, b) => b.node.count - a.node.count);
  workspace.settle();
  const bytes = blockBytes(rows, most, dims);
  // As in SH clustering, the threads only compute: they take all the room
  // but a small cache. Every byte of a thread is planned: its block's arrays
  // have their size, and its heap ends the thread at its limit.
  const threads =
    blocks.length > 1
      ? clusterers(workspace, bytes + HEAP_MB * 1024 ** 2, 0, blocks.length)
      : 0;
  const check = () => workspace.check();
  // The blocks that this thread simplifies: all without room for threads,
  // those that merge upward, and those whose planner outgrew a thread's heap.
  const own = [];
  let next = 0;
  let done = 0;
  if (threads) {
    const group = new WorkerGroup(
      new URL("./simplify.js", import.meta.url),
      threads,
      { simplifier: true, cancelled: workspace.cancelled },
      undefined,
      "Voxel simplification",
      HEAP_MB,
    );
    let failed = false;
    try {
      // Each thread has one block at a time, in its own arrays.
      await Promise.all(
        group.workers.map(async (worker) => {
          const arrays = blockArrays(rows, most, maxSh);
          while (!failed && next < blocks.length) {
            workspace.check();
            const block = blocks[next++];
            const { node, offset } = block;
            if (node.children) {
              own.push(block);
              continue;
            }
            source.load(node.start, node.count, arrays.records, arrays.sh);
            const job = { count: node.count, target: node.quota, maxSh };
            try {
              await group.request(worker, { ...job, ...arrays });
            } catch (error) {
              if (error.code !== "ERR_WORKER_OUT_OF_MEMORY") throw error;
              // The thread ended at its heap limit.
              own.push(block);
              return;
            }
            if (failed) return;
            output.store(offset, node.quota, arrays.merged, arrays.mergedSh);
            done += node.count;
            progress.update(done);
          }
        }),
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await group.close();
    }
    // The threads' memory has returned.
    workspace.settle();
  }
  own.push(...blocks.slice(next));
  if (own.length) {
    workspace.expect(bytes);
    const arrays = blockArrays(rows, most, maxSh);
    // Working blocks may merge upward; they never impose a root count floor.
    // Each child yields one splat.
    const mergeUp = (node, destination, base) => {
      const children = node.children && new Splats(workspace, maxSh);
      try {
        node.children?.forEach((child, i) => mergeUp(child, children, i));
        const count = children ? children.length : node.count;
        const { records, sh } = arrays;
        (children ?? source).load(
          children ? 0 : node.start,
          count,
          records,
          sh,
        );
        simplifyBlock({ count, target: 1, maxSh, ...arrays }, check);
        destination.store(base, 1, arrays.merged, arrays.mergedSh);
      } finally {
        children?.dispose();
      }
    };
    for (const { node, offset } of own) {
      workspace.check();
      if (node.children) mergeUp(node, output, offset);
      else {
        source.load(node.start, node.count, arrays.records, arrays.sh);
        const job = { count: node.count, target: node.quota, maxSh };
        simplifyBlock({ ...job, ...arrays }, check);
        output.store(offset, node.quota, arrays.merged, arrays.mergedSh);
      }
      done += node.count;
      progress.update(done);
    }
  }
  // The cache may take the memory of the blocks again.
  workspace.settle();
  workspace.expect(0);
}

async function reduce(source, target, context) {
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
  const progress = new Progress(
    `Simplifying ${source.length} → ${target}`,
    source.length,
  );
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
    await simplifyBlocks(source, root, limit, output, progress);
    if (output.length !== target)
      throw new Error("LOD count differs from its target");
    progress.finish(`${output.length} splats`);
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
      let current = source;
      try {
        while (current.length > target) {
          const next = await reduce(
            current,
            Math.max(target, Math.ceil(current.length / 2)),
            context,
          );
          if (current !== source) current.dispose();
          current = next;
        }
        levels.push(current);
        total += current.length;
      } catch (error) {
        if (current !== source) current.dispose();
        throw error;
      }
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
