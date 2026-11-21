import { HALF, halfBits } from "../rad/math.js";
import { Progress } from "../rad/progress.js";
import { IndexArray, Permutation } from "../rad/storage.js";
import { SH_DIMS } from "./splats.js";

// A cut contains nodes born before it whose parent has yet to be created.
// Collection consumes the temporary tree's geometry and leaf references.
export function collectLevels(input, tree, order, cuts, levels, pool) {
  const { workspace, length: leaves, maxSh } = input;
  const parent = new IndexArray(workspace);
  const progress = new Progress(
    "Collecting SOG levels",
    tree.length * (1 + maxSh),
  );
  // Divide the buffer allowance across cuts, down to one row per level.
  const batch = Math.max(1, Math.min(1024, Math.floor(16384 / cuts.length)));
  let completed = 0;
  let leafRows;

  function collect(row, readLeaf, readParent, write) {
    const width = row.length;
    const buffers = cuts.map(
      (cut) => new row.constructor(Math.min(batch, 2 * leaves - cut) * width),
    );
    const counts = new Uint32Array(cuts.length);
    const starts = new Uint32Array(cuts.length);

    function flush(i) {
      write(levels[i], starts[i], counts[i], buffers[i]);
      starts[i] += counts[i];
      counts[i] = 0;
    }

    let first = 0;
    for (let node = 0; node < tree.length; node++) {
      if ((node & 4095) === 0) progress.update(completed + node);
      if (node === cuts[first]) first++;
      const end = parent.get(node) || tree.length;
      const selected = cuts[first] <= end;
      if (node < leaves) {
        if (!selected) continue;
        readLeaf(node);
      } else {
        readParent(node, selected);
        if (!selected) continue;
      }
      for (let i = first; i < cuts.length && cuts[i] <= end; i++) {
        buffers[i].set(row, counts[i]++ * width);
        if (counts[i] * width === buffers[i].length) flush(i);
      }
    }

    for (let i = 0; i < cuts.length; i++) {
      if (counts[i]) flush(i);
      if (starts[i] !== 2 * leaves - cuts[i])
        throw new Error("LOD count differs from its target");
    }
    completed += tree.length;
  }

  try {
    for (let node = leaves; node < tree.length; node++) {
      const pair = (node - leaves) * 2;
      for (let k = pair; k < pair + 2; k++)
        parent.set(tree.children.get(k), node);
    }
    if (!tree.blend) tree.children.dispose();

    collectGeometry(input, tree, order, collect);
    tree.records.dispose();
    // Leaf SH in sorted-leaf order: leaves and the children of a level's
    // merges are then read within that level's size range.
    if (maxSh) leafRows = new Permutation(workspace, order, leaves);
    for (let band = 0; band < maxSh; band++)
      collectBand(input, tree, leafRows, pool, band, collect);
    progress.finish();
  } finally {
    parent.dispose();
    leafRows?.dispose();
  }
}

// Geometry is replayed first so the search records can be released before SH.
function collectGeometry(input, tree, order, collect) {
  const leaves = input.length;
  const blindRows = input.blind && new IndexArray(input.workspace);
  const record = new Float32Array(16);

  function readRecord(node, row) {
    tree.read(node, record);
    record[14] = row & 65535;
    record[15] = row >>> 16;
  }

  function readLeaf(node) {
    readRecord(node, blindRows ? order.get(node) : 0);
  }

  function readParent(node, selected) {
    let row = 0;
    if (blindRows) {
      const pair = (node - leaves) * 2;
      const heavier =
        tree.blend.get(pair) >= tree.blend.get(pair + 1) ? pair : pair + 1;
      const child = tree.children.get(heavier);
      row = child < leaves ? order.get(child) : blindRows.get(child - leaves);
      blindRows.set(node - leaves, row);
    }
    if (selected) readRecord(node, row);
  }

  try {
    collect(record, readLeaf, readParent, (level, start, count, buffer) =>
      level.store(start, count, buffer),
    );
  } finally {
    blindRows?.dispose();
  }
}

function collectBand(input, tree, leafRows, pool, band, collect) {
  const width = SH_DIMS[band];
  const column = leafRows.apply(input.sh[band], width, pool, { keep: true });
  const row = new Uint16Array(width);
  const other = new Uint16Array(width);

  function blend(node) {
    const pair = (node - input.length) * 2;
    column.read(tree.children.get(pair) * width, row);
    column.read(tree.children.get(pair + 1) * width, other);
    const w = tree.blend.get(pair);
    const v = tree.blend.get(pair + 1);
    for (let d = 0; d < width; d++)
      row[d] = halfBits(HALF[row[d]] * w + HALF[other[d]] * v);
    column.write(node * width, row);
  }

  try {
    collect(
      row,
      (node) => column.read(node * width, row),
      blend,
      (level, start, count, buffer) =>
        level.sh[band].write(start * width, buffer, count * width),
    );
  } finally {
    column.dispose();
  }
}
