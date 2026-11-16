// Keep octree bounds in units of the initial grid, including
// through skipped single-child levels. Partition row indices stably in place.
function splitCell(cell, cloud, inverse, room, scratch, slots, check) {
  const { positions, origin } = cloud;
  const min = new Array(3).fill(Number.POSITIVE_INFINITY);
  const max = new Array(3).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < cell.rows.length; i++) {
    if ((i & 4095) === 0) check();
    const at = cell.rows[i] * 3;
    for (let d = 0; d < 3; d++) {
      const value = (positions[at + d] - origin[d]) * inverse;
      min[d] = Math.min(min[d], value);
      max[d] = Math.max(max[d], value);
    }
  }
  if (min.every((v, d) => v === max[d])) return;

  const lower = cell.min.slice();
  const upper = cell.max.slice();
  const middle = new Array(3);
  for (;;) {
    check();
    for (let d = 0; d < 3; d++) middle[d] = (lower[d] + upper[d]) * 0.5;
    if (min.some((v, d) => v < middle[d] && max[d] >= middle[d])) break;
    let changed = false;
    for (let d = 0; d < 3; d++) {
      const bound = min[d] >= middle[d] ? lower : upper;
      changed ||= bound[d] !== middle[d];
      bound[d] = middle[d];
    }
    if (!changed) return;
  }
  const counts = new Uint32Array(8);
  let occupied = 0;
  for (let i = 0; i < cell.rows.length; i++) {
    if ((i & 4095) === 0) check();
    const at = cell.rows[i] * 3;
    let slot = 0;
    for (let d = 0; d < 3; d++)
      if ((positions[at + d] - origin[d]) * inverse >= middle[d])
        slot |= 1 << d;
    slots[i] = slot;
    if (counts[slot]++ === 0) {
      // More occupied children cannot fit, even before scanning the rest.
      if (++occupied > room) return;
    }
  }
  // Counts become the write cursors after each child takes its row range.
  const children = [];
  let start = 0;
  for (let slot = 0; slot < 8; slot++) {
    const count = counts[slot];
    counts[slot] = start;
    if (!count) continue;
    children.push({
      rows: cell.rows.subarray(start, start + count),
      min: lower.map((v, d) => (slot & (1 << d) ? middle[d] : v)),
      max: upper.map((v, d) => (slot & (1 << d) ? v : middle[d])),
      neighbors: [],
    });
    start += count;
  }
  for (let i = 0; i < cell.rows.length; i++) {
    if ((i & 4095) === 0) check();
    scratch[counts[slots[i]]++] = cell.rows[i];
  }
  cell.rows.set(scratch.subarray(0, cell.rows.length));
  return children;
}

function touches(a, b) {
  for (let d = 0; d < 3; d++)
    if (a.min[d] > b.max[d] || b.min[d] > a.max[d]) return false;
  return true;
}

export function refineVoxelGrid(
  cloud,
  inverse,
  coordinates,
  grid,
  threshold,
  maxGroups,
  check,
) {
  const { groupOffsets, groupIndices, neighborGroupsByGroup } = grid;
  const initial = groupOffsets.length - 1;
  let largest = 0;
  for (let i = 0; i < initial; i++)
    largest = Math.max(largest, groupOffsets[i + 1] - groupOffsets[i]);
  if (largest <= threshold || initial === maxGroups) return grid;

  const scratch = new Int32Array(largest);
  const slots = new Uint8Array(largest);
  const stack = Array.from({ length: initial }, (_, i) => {
    const min = Array.from(coordinates.subarray(i * 3, i * 3 + 3));
    return {
      min,
      max: min.map((v) => v + 1),
      rows: groupIndices.subarray(groupOffsets[i], groupOffsets[i + 1]),
    };
  });
  stack.forEach((cell, i) => {
    cell.neighbors = [];
    for (const n of neighborGroupsByGroup[i])
      if (n !== i) cell.neighbors.push(stack[n]);
  });
  stack.reverse();
  const leaves = [];
  let active = initial;
  while (stack.length) {
    check();
    const cell = stack.pop();
    const children =
      cell.rows.length > threshold && active < maxGroups
        ? splitCell(
            cell,
            cloud,
            inverse,
            maxGroups - active + 1,
            scratch,
            slots,
            check,
          )
        : undefined;
    if (!children) {
      cell.index = leaves.length;
      leaves.push(cell);
      continue;
    }
    active += children.length - 1;
    for (const other of cell.neighbors) {
      const at = other.neighbors.indexOf(cell);
      other.neighbors[at] = other.neighbors.at(-1);
      other.neighbors.pop();
      for (const child of children)
        if (touches(other, child)) {
          other.neighbors.push(child);
          child.neighbors.push(other);
        }
    }
    // Siblings all touch at their common midpoint.
    for (let i = 0; i < children.length; i++)
      for (let j = i + 1; j < children.length; j++) {
        children[i].neighbors.push(children[j]);
        children[j].neighbors.push(children[i]);
      }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  if (active === initial) return grid;

  const offsets = new Uint32Array(leaves.length + 1);
  const neighbors = new Array(leaves.length);
  for (let i = 0; i < leaves.length; i++) {
    check();
    const cell = leaves[i];
    offsets[i + 1] = offsets[i] + cell.rows.length;
    neighbors[i] = cell.neighbors.map((n) => n.index);
    neighbors[i].push(i);
    neighbors[i].sort((a, b) => a - b);
  }
  return {
    groupOffsets: offsets,
    groupIndices,
    neighborGroupsByGroup: neighbors,
  };
}
