import { Pool } from "../rad/parallel.js";
import { Permutation } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";

// The region order contains one complete permutation per LOD, in write order.
// Worker threads copy the rows; they end before the encoders start.
export async function orderChunks(rows, order) {
  const { workspace, levels, starts } = rows;
  const blindWidth = levels[0].blind?.fields.length;
  const pool = new Pool(workspace, rows.length);
  try {
    pool.ready();
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const perm = new Permutation(
        workspace,
        order.consumingRange(starts[i], level.length),
        level.length,
        `Indexing SOG LOD ${i}`,
      );
      const reorder = (column, stride, name) =>
        perm.apply(column, stride, pool, {
          label: `Ordering SOG LOD ${i} ${name}`,
        });
      try {
        level.records = reorder(level.records, 16, "geometry");
        for (let band = 0; band < level.maxSh; band++)
          level.sh[band] = reorder(
            level.sh[band],
            SH_DIMS[band],
            `SH${band + 1}`,
          );
        if (blindWidth)
          level.blindValues = reorder(level.blindValues, blindWidth, "Blind");
      } finally {
        perm.dispose();
      }
    }
  } finally {
    await pool.close();
    workspace.settle();
    workspace.expect(0);
  }
}
