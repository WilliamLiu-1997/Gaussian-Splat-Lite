import { Permutation } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";

// Materialize working blocks once, instead of scanning scattered source pages
// again for every block. The shared copier preserves Float32, including SH4.
export function reorder(source, order, pool) {
  const { workspace } = source;
  workspace.settle();
  let permutation;
  try {
    permutation = new Permutation(
      workspace,
      order,
      source.length,
      "Preparing voxel blocks",
    );
    source.records = permutation.apply(
      source.records,
      16,
      pool,
      false,
      "Grouping splat attributes",
    );
    for (let band = 0; band < source.maxSh; band++)
      source.sh[band] = permutation.apply(
        source.sh[band],
        SH_DIMS[band],
        pool,
        false,
        `Grouping SH${band + 1}`,
      );
  } finally {
    permutation?.dispose();
  }
}
