import { HALF, halfBits } from "./math.js";
import { Progress } from "./progress.js";
import { SH_DIMS } from "./splats.js";

// Merged splats blended at a time, and the children they may have: a splat
// with more grows the buffers.
const BATCH = 16384;
const CHILDREN = 65536;

// Blends each merged splat's SH from its children's, weighted as they
// merged, once the tree is built. Decoded rows are first put in the order
// merges read them, so only merged children are read at random. Children
// precede their parent; one merged in the same batch is read from the batch.
export function blendSh(splats, initial, pool) {
  if (!splats.maxSh) return;
  const { workspace } = splats;
  const leafRows = splats.shReads(initial);
  const counts = new Uint32Array(BATCH);
  let children = new Uint32Array(CHILDREN);
  let weights = new Float64Array(CHILDREN);
  for (let band = 0; band < splats.maxSh; band++) {
    const dims = SH_DIMS[band];
    const column = leafRows.apply(
      splats.sh[band],
      dims,
      pool,
      false,
      `Reordering SH${band + 1}`,
    );
    splats.sh[band] = column;
    const progress = new Progress(
      `Blending SH${band + 1}`,
      splats.length - initial,
    );
    const blended = new Uint16Array(BATCH * dims);
    const sums = new Float64Array(dims);
    const row = new Uint16Array(dims);
    let leaves = new Uint16Array(children.length * dims);
    // The decoded rows and the children read so far.
    let next = 0;
    let first = 0;
    for (let start = initial; start < splats.length; ) {
      workspace.check();
      const limit = Math.min(BATCH, splats.length - start);
      splats.childCount.read(start, counts, limit);
      let count = 1;
      let total = counts[0];
      while (count < limit && total + counts[count] <= CHILDREN)
        total += counts[count++];
      if (total > children.length) {
        children = new Uint32Array(total);
        weights = new Float64Array(total);
      }
      if (total * dims > leaves.length) leaves = new Uint16Array(total * dims);
      splats.children.read(first, children, total);
      splats.blend.read(first, weights, total);
      let decoded = 0;
      for (let c = 0; c < total; c++) if (children[c] < initial) decoded++;
      column.read(next * dims, leaves, decoded * dims);
      next += decoded;
      let leaf = 0;
      let c = 0;
      for (let i = 0; i < count; i++) {
        sums.fill(0);
        let weight = 0;
        for (const end = c + counts[i]; c < end; c++) {
          const child = children[c];
          let source = leaves;
          let at = leaf;
          if (child < initial) leaf += dims;
          else if (child >= start) {
            source = blended;
            at = (child - start) * dims;
          } else {
            source = column.read(child * dims, row, dims);
            at = 0;
          }
          const w = weights[c];
          weight += w;
          for (let d = 0; d < dims; d++) sums[d] += w * HALF[source[at + d]];
        }
        for (let d = 0; d < dims; d++)
          blended[i * dims + d] = halfBits(sums[d] / weight);
      }
      column.write(start * dims, blended, count * dims);
      first += total;
      start += count;
      progress.update(start - initial);
    }
    progress.finish();
  }
  leafRows.dispose();
  splats.blend.dispose();
}
