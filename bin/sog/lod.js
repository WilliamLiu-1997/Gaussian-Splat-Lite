import { sortSplats } from "../rad/heap.js";
import { mergeLevels } from "../rad/lod.js";
import { Pool } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import { Splats as RadSplats, refresh } from "../rad/splats.js";
import { collectBlindValues, collectLevels } from "./lod-levels.js";
import { Splats } from "./splats.js";

const MAX_HALF = 65504;

function prepareTree(input, tree) {
  const block = 4096;
  const rows = new Float32Array(block * 16);
  const sizes = new Float32Array(block);
  const progress = new Progress("Preparing LOD leaves", input.length);
  for (let base = 0; base < input.length; base += block) {
    const count = Math.min(block, input.length - base);
    input.records.read(base * 16, rows, count * 16);
    for (let i = 0; i < count; i++) {
      const at = i * 16;
      // The merge search stores colors as halves; the finest level keeps the input's.
      for (let d = 4; d < 7; d++)
        rows[at + d] = Math.max(-MAX_HALF, Math.min(MAX_HALF, rows[at + d]));
      refresh(rows, at);
      if (!Number.isFinite(rows[at + 14]) || !Number.isFinite(rows[at + 15]))
        throw new Error("LOD scale overflow");
      sizes[i] = rows[at + 14];
    }
    tree.records.write(base * 16, rows, count * 16);
    tree.sizes.write(base, sizes, count);
    progress.update(base + count);
  }
  tree.length = input.length;
  progress.finish();
}

export async function buildLevels(input, rootSplats, factor) {
  const { workspace, length, maxSh } = input;
  const cuts = [];
  let target = length;
  let total = length;
  while (target > rootSplats) {
    target = Math.min(target - 1, Math.ceil(target / factor));
    total += target;
    if (!Number.isSafeInteger(total))
      throw new Error("Combined LOD count exceeds the safe integer limit");
    // The first N nodes are leaves. Each following node reduces the live count by one.
    cuts.push(length + (length - target));
  }
  if (!cuts.length) {
    console.log(`LOD counts: ${length}`);
    return [input];
  }
  if (cuts.at(-1) > 0xffffffff)
    throw new Error("Input exceeds LOD u32 index limit");

  const levels = cuts.map(() => new Splats(workspace, maxSh));
  async function collectTree() {
    const tree = new RadSplats(workspace, 0, {});
    const pool = new Pool(workspace, length);
    let order;
    try {
      pool.ready();
      prepareTree(input, tree);
      // After merging, collection reads attributes before the region split.
      const columns = input.sh.slice(0, maxSh);
      if (input.blindValues) columns.push(input.blindValues);
      workspace.rest([...columns, input.centers, input.records]);
      const attributes = columns.length > 0;
      order = sortSplats(tree, pool, attributes);
      mergeLevels(tree, pool, target, attributes);
      workspace.rest([]);
      tree.sizes.dispose();
      return collectLevels(input, tree, order, cuts, levels, pool);
    } finally {
      try {
        await pool.close();
      } finally {
        order?.dispose();
        tree.dispose();
      }
    }
  }

  try {
    const refs = await collectTree();
    workspace.settle();
    workspace.expect(0);
    if (refs) collectBlindValues(input, levels, refs);
    console.log(
      `LOD counts: ${[length, ...levels.map((level) => level.length)].join(" → ")}`,
    );
    return [input, ...levels];
  } catch (error) {
    for (const level of levels) level.dispose();
    throw error;
  }
}
