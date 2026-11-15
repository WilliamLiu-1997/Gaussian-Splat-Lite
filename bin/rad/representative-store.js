// Reads a block's records into a worker's `inputs`, runs of consecutive
// splats at once, and its splats and their weights into `results`. Without
// `nodes` the block is rows [start, start + count) themselves.
export function loadRepresentativeBlock(splats, nodes, block, inputs, results) {
  const { records } = inputs;
  const { indices, weights } = results;
  const { start, count } = block;
  if (nodes) nodes.read(start, indices, count);
  else for (let i = 0; i < count; i++) indices[i] = start + i;
  for (let i = 0; i < count; ) {
    let end = i + 1;
    while (end < count && indices[end] === indices[end - 1] + 1) end++;
    splats.records.read(indices[i] * 16, records, (end - i) * 16, i * 16);
    i = end;
  }
  for (let i = 0; i < count; i++)
    weights[i] = records[i * 16 + 15] * records[i * 16 + 3];
}

// Only this thread appends tree nodes. Commit blocks in their spatial order
// so thread completion order cannot change node IDs or the output file. SH
// does not affect merging: each child's weight is kept for blendSh().
export class RepresentativeStore {
  // Blocks hold at most `count` splats and merge into at most `target`.
  constructor(splats, count, target) {
    this.splats = splats;
    this.record = new Float32Array(16);
    this.ids = new Uint32Array(target);
    this.centers = new Float32Array(target * 4);
    this.children = new Uint32Array(count);
    this.blend = new Float64Array(count);
  }

  // Adds a block's merged splats, and its results to `next`, the splats of
  // the next round, with their centers in `positions` if that divides them.
  append(results, target, next, positions) {
    const { splats, record, ids, centers, children, blend } = this;
    const { indices, rows, offsets, merged, weights } = results;
    const first = splats.children.length;
    let members = 0;
    for (let slot = 0; slot < target; slot++) {
      const start = offsets[slot];
      const end = offsets[slot + 1];
      const at = slot * 16;
      for (let d = 0; d < 3; d++) centers[slot * 4 + d] = merged[at + d];
      if (end - start === 1) {
        ids[slot] = indices[rows[start]];
        continue;
      }
      const index = splats.length++;
      ids[slot] = index;
      splats.childStart.set(index, first + members);
      splats.childCount.set(index, end - start);
      for (let p = start; p < end; p++) {
        children[members] = indices[rows[p]];
        blend[members++] = weights[rows[p]];
      }
      for (let d = 0; d < 16; d++) record[d] = merged[at + d];
      splats.records.write(index * 16, record);
      splats.weight.set(index, merged[at + 15] * merged[at + 3]);
      splats.sizes.set(index, merged[at + 14]);
    }
    splats.children.write(first, children, members);
    if (splats.maxSh) splats.blend.write(first, blend, members);
    next.write(next.length, ids, target);
    positions?.write(positions.length, centers, target * 4);
  }
}
