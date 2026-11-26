import { Pool } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import { Permutation } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";

// The region order contains one complete permutation per LOD, in write order.
// Worker threads copy the rows; they end before the encoders start.
export async function orderChunks(rows, order) {
  const { workspace, levels, starts } = rows;
  const blindWidth = levels[0].blind?.fields.length;
  // One indexing pass, then geometry, SH bands and any Blind data.
  const passes = 2 + levels[0].maxSh + (blindWidth ? 1 : 0);
  const progress = new Progress(
    "Ordering SOG chunks",
    rows.length * passes,
    "",
    true,
  );
  let completed = 0;
  const advance = (count) => {
    completed += count;
    progress.update(completed);
  };
  const visit = (_output, start, end) => advance(end - start);
  const pool = new Pool(workspace, rows.length);
  try {
    pool.ready();
    // Evict already ordered columns and distant inputs before the active source.
    const pending = new Set(
      levels
        .flatMap((level) => [
          level.records,
          ...level.sh.slice(0, level.maxSh),
          ...(blindWidth ? [level.blindValues] : []),
        ])
        .reverse(),
    );
    const ordered = [];
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      workspace.rest([...pending, ...ordered]);
      const perm = new Permutation(
        workspace,
        order.consumingRange(starts[i], level.length),
        level.length,
      );
      const reorder = (column, stride) => {
        pending.delete(column);
        workspace.rest([...pending, ...ordered]);
        const result = perm.apply(column, stride, pool, { visit });
        ordered.push(result);
        return result;
      };
      try {
        advance(level.length);
        level.records = reorder(level.records, 16);
        for (let band = 0; band < level.maxSh; band++)
          level.sh[band] = reorder(level.sh[band], SH_DIMS[band]);
        if (blindWidth)
          level.blindValues = reorder(level.blindValues, blindWidth);
      } finally {
        perm.dispose();
      }
    }
  } finally {
    workspace.rest([]);
    await pool.close();
    workspace.settle();
    workspace.expect(0);
  }
  progress.finish();
}
