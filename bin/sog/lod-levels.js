import { SKIP_BLEND } from "../rad/parallel.js";
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
  let lastPass = !maxSh && !blind;

  // emit(i) appends the current row to cut i and returns its row number there.
  function collect(row, visit, write, consumed, prepare) {
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
      if (lastPass) ranges.consume(base * 2, bounds, count * 2);
      else ranges.read(base * 2, bounds, count * 2);
      prepare?.(base, count);
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

  function collectColumn(row, read, write, consumed, prepare) {
    collect(
      row,
      (node, first, end, emit) => {
        if (first < end) read(node);
        for (let i = first; i < end; i++) emit(i);
      },
      write,
      consumed,
      prepare,
    );
  }

  try {
    const record = new Float32Array(16);
    collectColumn(
      record,
      (node) => tree.read(node, record),
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
    lastPass = true;
    const refs = blind && blindRows();
    progress.finish();
    return refs;
  } finally {
    workspace.rest([]);
    ranges.dispose();
  }

  function collectBand(band, leafRows) {
    const width = SH_DIMS[band];
    // Later stages own these columns; evict them before the active tree.
    const idle = [
      ...input.sh.slice(band + 1, maxSh).reverse(),
      input.records,
      input.centers,
      ...levels.map((level) => level.records),
      ...levels.map((level) => level.centers),
      ...levels.flatMap((level) => level.sh.slice(0, band)),
      ...input.sh.slice(0, band),
    ];
    workspace.rest([...idle]);
    const column = leafRows.apply(input.sh[band], width, pool, { keep: true });
    workspace.rest([...idle, input.sh[band]]);
    lastPass = band + 1 === maxSh && !blind;
    const row = new Uint16Array(width);
    const rows = [row, new Uint16Array(width)];
    const pairs = new Uint32Array(bounds.length);
    let firstParent;

    // Parents in a batch can depend on earlier parents in that same batch.
    // Use the same parallel blend and ordered dependency resolution as RAD.
    function prepare(base, count) {
      firstParent = Math.max(base, leaves);
      const parents = base + count - firstParent;
      if (parents <= 0) return;
      const pair = (firstParent - leaves) * 2;
      if (lastPass) {
        tree.children.consume(pair, pairs, parents * 2);
        tree.blend.consume(pair, pool.blends, parents * 2);
      } else {
        tree.children.read(pair, pairs, parents * 2);
        tree.blend.read(pair, pool.blends, parents * 2);
      }
      let end = 0;
      for (let i = 0; i < parents; i++) {
        // A selected merge can feed a later parent even if no cut emits its row.
        if (bounds[(firstParent - base + i) * 2] === levels.length) {
          pool.later[i] = SKIP_BLEND;
          continue;
        }
        end = i + 1;
        const a = pairs[i * 2];
        const b = pairs[i * 2 + 1];
        pool.nodes[i] = a;
        pool.entries[i] = b;
        pool.later[i] = Number(a >= firstParent || b >= firstParent);
      }
      if (end) pool.blend(column, firstParent, end, width, rows);
    }

    const read = (node) => {
      if (node < leaves) column.read(node * width, row);
      else {
        const at = (node - firstParent) * width;
        for (let d = 0; d < width; d++) row[d] = pool.blended[at + d];
      }
    };
    try {
      collectColumn(
        row,
        read,
        (i, start, count, buffer) =>
          levels[i].sh[band].write(start * width, buffer, count * width),
        undefined,
        prepare,
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
