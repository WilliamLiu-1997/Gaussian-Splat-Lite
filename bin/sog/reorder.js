import { Permutation } from "../rad/storage.js";
import { BATCH } from "./positions.js";
import { SH_DIMS } from "./splats.js";

// Materialize working blocks once, instead of scanning scattered source pages
// again for every block. The shared copier keeps every value as it is, the
// half bits of SH too, and the centers follow from the records while each
// window of them is cached.
export function reorder(source, order, pool, update) {
  const { workspace, centers, blind } = source;
  centers.dispose();
  workspace.settle();
  let permutation;
  try {
    permutation = new Permutation(workspace, order, source.length);
    const columns = 1 + source.maxSh + Number(Boolean(blind));
    let copied = 0;
    const advance = (count) => {
      copied += count;
      update?.(copied / columns);
    };
    const rows = new Float32Array(BATCH * 16);
    const values = new Float32Array(BATCH * 3);
    source.records = permutation.apply(
      source.records,
      16,
      pool,
      false,
      undefined,
      (records, start, end) => {
        for (let base = start; base < end; base += BATCH) {
          const count = Math.min(BATCH, end - base);
          records.read(base * 16, rows, count * 16);
          for (let i = 0; i < count; i++)
            for (let d = 0; d < 3; d++) values[i * 3 + d] = rows[i * 16 + d];
          centers.write(base * 3, values, count * 3);
          advance(count);
        }
      },
    );
    for (let band = 0; band < source.maxSh; band++)
      source.sh[band] = permutation.apply(
        source.sh[band],
        SH_DIMS[band],
        pool,
        false,
        undefined,
        (_column, start, end) => advance(end - start),
      );

    // Only the input owns Blind data; later LODs keep references to these rows.
    if (blind)
      blind.values = permutation.apply(
        blind.values,
        blind.fields.length,
        pool,
        false,
        undefined,
        (_column, start, end) => advance(end - start),
      );
  } finally {
    permutation?.dispose();
  }
}
