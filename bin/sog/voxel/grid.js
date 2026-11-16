import { cellHash } from "../../rad/grid.js";
import { refineVoxelGrid } from "./refine.js";

// Rebuild at each sqrt(2) scale, then refine dense cells by octree subdivision.
export function buildVoxelGrid(
  cloud,
  voxelTarget,
  splitThreshold,
  maxGroups,
  check,
) {
  const { positions, length: count, minFeature, origin } = cloud;
  const capacity = 2 ** Math.ceil(Math.log2(voxelTarget * 2));
  const table = new Uint32Array(capacity);
  const coordinates = new Float64Array(voxelTarget * 3);
  const counts = new Uint32Array(voxelTarget);
  const pointGroups = new Uint32Array(count);
  let level = Math.ceil(Math.log2(Math.max(minFeature, 0.000001)) * 2);
  let inverse;
  let groups = 0;

  const slotFor = (x, y, z) => {
    let slot = cellHash(x, y, z) & (capacity - 1);
    while (table[slot]) {
      const at = (table[slot] - 1) * 3;
      if (
        coordinates[at] === x &&
        coordinates[at + 1] === y &&
        coordinates[at + 2] === z
      )
        break;
      slot = (slot + 1) & (capacity - 1);
    }
    return slot;
  };

  for (;;) {
    check();
    table.fill(0);
    groups = 0;
    inverse = 1 / 2 ** (level / 2);
    let row = 0;
    for (; row < count; row++) {
      if ((row & 4095) === 0) check();
      const at = row * 3;
      const x = Math.floor((positions[at] - origin[0]) * inverse);
      const y = Math.floor((positions[at + 1] - origin[1]) * inverse);
      const z = Math.floor((positions[at + 2] - origin[2]) * inverse);
      const slot = slotFor(x, y, z);
      if (!table[slot]) {
        // Reject an oversized grid as soon as its budget is exceeded.
        if (groups === voxelTarget) break;
        coordinates[groups * 3] = x;
        coordinates[groups * 3 + 1] = y;
        coordinates[groups * 3 + 2] = z;
        counts[groups] = 0;
        table[slot] = ++groups;
      }
      const group = table[slot] - 1;
      pointGroups[row] = group;
      counts[group]++;
    }
    if (row === count) break;
    level++;
  }

  const groupOffsets = new Uint32Array(groups + 1);
  for (let group = 0; group < groups; group++)
    groupOffsets[group + 1] = groupOffsets[group] + counts[group];
  // Counts are no longer needed: reuse them as write cursors, then stamps.
  const cursors = counts;
  cursors.set(groupOffsets.subarray(0, groups));
  const groupIndices = new Int32Array(count);
  for (let row = 0; row < count; row++) {
    if ((row & 4095) === 0) check();
    groupIndices[cursors[pointGroups[row]]++] = row;
  }

  const visited = counts.fill(0, 0, groups);
  const neighborGroupsByGroup = new Array(groups);
  for (let group = 0; group < groups; group++) {
    if ((group & 255) === 0) check();
    const x = coordinates[group * 3];
    const y = coordinates[group * 3 + 1];
    const z = coordinates[group * 3 + 2];
    const neighbors = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const neighbor = table[slotFor(x + dx, y + dy, z + dz)];
          if (neighbor && visited[neighbor - 1] !== group + 1) {
            visited[neighbor - 1] = group + 1;
            neighbors.push(neighbor - 1);
          }
        }
      }
    }
    neighborGroupsByGroup[group] = neighbors.sort((a, b) => a - b);
  }
  return refineVoxelGrid(
    cloud,
    inverse,
    coordinates,
    { groupOffsets, groupIndices, neighborGroupsByGroup },
    splitThreshold,
    maxGroups,
    check,
  );
}
