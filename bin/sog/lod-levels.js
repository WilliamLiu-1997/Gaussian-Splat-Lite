import { HALF, halfBits } from "../rad/math.js";
import { Progress } from "../rad/progress.js";
import { IndexArray, Permutation } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";

// Collection consumes the temporary tree's geometry and leaf references.
// `ranges` holds the first level of each node, then how many levels before
// the coarsest it ends; see selectLevels().
export function collectLevels(
  input,
  tree,
  order,
  targets,
  ranges,
  levels,
  pool,
) {
  const { workspace, length: leaves, maxSh, blind } = input;
  const bounds = new ranges.Type(4096 * 2);
  const progress = new Progress(
    "Collecting SOG levels",
    tree.length * (1 + maxSh + (blind ? 1 : 0)),
  );
  let completed = 0;

  // emit(i) appends the current row to cut i and returns its row number there.
  function collect(row, visit, write, consumed) {
    const width = row.length;
    // Share one MiB of buffers across cuts, down to one row per level.
    const batch = Math.max(
      1,
      Math.min(1024, Math.floor(1024 ** 2 / levels.length / row.byteLength)),
    );
    const buffers = targets.map(
      (target) => new row.constructor(Math.min(batch, target) * width),
    );
    const counts = new Uint32Array(levels.length);
    const starts = new Uint32Array(levels.length);

    function flush(i) {
      write(i, starts[i], counts[i], buffers[i]);
      starts[i] += counts[i];
      counts[i] = 0;
    }

    function emit(i) {
      buffers[i].set(row, counts[i]++ * width);
      if (counts[i] * width === buffers[i].length) flush(i);
      return starts[i] + counts[i] - 1;
    }

    const block = bounds.length / 2;
    for (let base = 0; base < tree.length; base += block) {
      workspace.check();
      progress.update(completed + base);
      const count = Math.min(block, tree.length - base);
      if (maxSh || blind) ranges.read(base * 2, bounds, count * 2);
      else ranges.consume(base * 2, bounds, count * 2);
      for (let i = 0; i < count; i++) {
        const first = bounds[i * 2];
        if (first < levels.length)
          visit(base + i, first, levels.length - bounds[i * 2 + 1], emit);
      }
      consumed?.discard(base * width, (base + count) * width);
    }

    for (let i = 0; i < levels.length; i++) {
      if (counts[i]) flush(i);
      if (starts[i] !== targets[i])
        throw new Error("LOD count differs from its target");
    }
    completed += tree.length;
  }

  function collectColumn(row, read, merge, write, consumed) {
    collect(
      row,
      (node, first, end, emit) => {
        if (node >= leaves && merge) merge(node);
        else if (first < end) read(node);
        for (let i = first; i < end; i++) emit(i);
      },
      write,
      consumed,
    );
  }

  try {
    const record = new Float32Array(16);
    collectColumn(
      record,
      (node) => tree.read(node, record),
      undefined,
      (i, start, count, buffer) => levels[i].store(start, count, buffer),
      tree.records,
    );
    tree.records.dispose();
    if (maxSh) {
      const leafRows = new Permutation(
        workspace,
        blind ? order : order.consumingRange(),
        leaves,
      );
      if (!blind) order.dispose();
      try {
        for (let band = 0; band < maxSh; band++) collectBand(band, leafRows);
      } finally {
        leafRows.dispose();
      }
    }
    const refs = blind && blindRows();
    progress.finish();
    return refs;
  } finally {
    ranges.dispose();
  }

  function collectBand(band, leafRows) {
    const width = SH_DIMS[band];
    const column = leafRows.apply(input.sh[band], width, pool, { keep: true });
    const row = new Uint16Array(width);
    const other = new Uint16Array(width);
    const read = (node) => column.read(node * width, row);
    function merge(node) {
      const pair = (node - leaves) * 2;
      const w = tree.blend.get(pair);
      const v = tree.blend.get(pair + 1);
      read(tree.children.get(pair));
      column.read(tree.children.get(pair + 1) * width, other);
      for (let d = 0; d < width; d++)
        row[d] = halfBits(HALF[row[d]] * w + HALF[other[d]] * v);
      column.write(node * width, row);
    }

    try {
      collectColumn(row, read, merge, (i, start, count, buffer) =>
        levels[i].sh[band].write(start * width, buffer, count * width),
      );
    } finally {
      column.dispose();
    }
  }

  // A node inherits one row from its heavier child. At each cut, record
  // that row and carry its new row number forward to the next coarser cut.
  function blindRows() {
    const refs = levels.map(() => new IndexArray(workspace));
    const row = new Uint32Array(1);
    function inherit(node, first, end, emit) {
      let child = node;
      if (node >= leaves) {
        const pair = (node - leaves) * 2;
        const left = tree.blend.get(pair) >= tree.blend.get(pair + 1);
        child = tree.children.get(left ? pair : pair + 1);
      } else if (first === end) return;
      row[0] = order.get(child);
      for (let i = first; i < end; i++) row[0] = emit(i);
      order.set(node, row[0]);
    }
    collect(row, inherit, (i, start, count, buffer) =>
      refs[i].write(start, buffer, count),
    );
    return refs;
  }
}

// Copy the selected Blind rows once the merge tree and its pool are released.
export function collectBlindValues(input, levels, refs) {
  let previous = input;
  for (const [i, level] of levels.entries()) {
    const indices = refs[i];
    const perm = new Permutation(
      input.workspace,
      indices.consumingRange(),
      previous.length,
    );
    indices.dispose();
    try {
      level.blindValues = perm.apply(
        previous.blindValues,
        input.blind.fields.length,
        undefined,
        { keep: true, label: `Collecting SOG LOD ${i + 1} Blind` },
      );
    } finally {
      perm.dispose();
    }
    previous = level;
  }
}
