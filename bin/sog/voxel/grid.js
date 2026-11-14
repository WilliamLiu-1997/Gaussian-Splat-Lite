import { roundHalfToEven } from "./utils.js";
const ADAPTIVE_VOXEL_NEIGHBOR_EPSILON = 1e-12;

function chooseGridDimsForExtents(extents, targetCount) {
  const ext = extents.map((v) => Math.max(v, 1e-6));
  const maxExt = Math.max(ext[0], ext[1], ext[2]);
  const ratios = ext.map((v) => v / maxExt);
  const base = Math.max(1.0, targetCount ** (1.0 / 3.0));
  let dims = ratios.map((r) => Math.max(1, roundHalfToEven(base * r)));
  const prod = Math.max(1, dims[0] * dims[1] * dims[2]);
  const scale = (targetCount / prod) ** (1.0 / 3.0);
  dims = dims.map((d) => Math.max(1, roundHalfToEven(d * scale)));
  return dims;
}

function chooseGridDims(bounds, targetCount) {
  return chooseGridDimsForExtents(bounds.extents(), targetCount);
}

function gridProduct(dims) {
  return dims[0] * dims[1] * dims[2];
}

function clampGridCoord(value, dim) {
  let uvw = value;
  if (uvw < 0.0) uvw = 0.0;
  else if (uvw > 0.999999) uvw = 0.999999;
  return Math.floor(uvw * dim);
}

function computeNormalizedPositions(pos, rowCount, minimum, invExtents) {
  const out = new Float32Array(rowCount * 3);
  const m0 = minimum[0];
  const m1 = minimum[1];
  const m2 = minimum[2];
  const invExt0 = invExtents[0];
  const invExt1 = invExtents[1];
  const invExt2 = invExtents[2];
  for (let i = 0; i < rowCount; i++) {
    const i3 = i * 3;
    const p0 = pos[i3];
    const p1 = pos[i3 + 1];
    const p2 = pos[i3 + 2];
    out[i3 + 0] = Math.max(0.0, Math.min(0.999999, (p0 - m0) * invExt0));
    out[i3 + 1] = Math.max(0.0, Math.min(0.999999, (p1 - m1) * invExt1));
    out[i3 + 2] = Math.max(0.0, Math.min(0.999999, (p2 - m2) * invExt2));
  }
  return out;
}

function flatGridCellForNormalizedPoint(normalizedPositions, row, dims) {
  const row3 = row * 3;
  const d0 = dims[0];
  const d1 = dims[1];
  const i = clampGridCoord(normalizedPositions[row3 + 0], d0);
  const j = clampGridCoord(normalizedPositions[row3 + 1], d1);
  const k = clampGridCoord(normalizedPositions[row3 + 2], dims[2]);
  return i + d0 * (j + d1 * k);
}

function countGridCells(normalizedPositions, rowCount, dims, pointFlats) {
  const counts = new Uint32Array(gridProduct(dims));
  for (let row = 0; row < rowCount; row++) {
    const flat = flatGridCellForNormalizedPoint(normalizedPositions, row, dims);
    pointFlats[row] = flat;
    counts[flat] += 1;
  }
  let occupied = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) {
      occupied += 1;
    }
  }
  return { cellCounts: counts, occupied };
}

function chooseInitialAdaptiveVoxelGrid(
  activeBounds,
  voxelTarget,
  normalizedPositions,
  rowCount,
) {
  let dims = chooseGridDims(activeBounds, voxelTarget);
  const pointFlats = new Int32Array(rowCount);
  while (true) {
    const { cellCounts, occupied } = countGridCells(
      normalizedPositions,
      rowCount,
      dims,
      pointFlats,
    );
    if (occupied <= voxelTarget) {
      return { dims, cellCounts, pointFlats };
    }
    dims = [
      Math.max(1, Math.floor(dims[0] * 0.85)),
      Math.max(1, Math.floor(dims[1] * 0.85)),
      Math.max(1, Math.floor(dims[2] * 0.85)),
    ];
  }
}

function adaptiveVoxelFromGridCell(rows, dims, flat, depth = 0) {
  const d0 = dims[0];
  const d1 = dims[1];
  const gx = flat % d0;
  const gy = Math.floor(flat / d0) % d1;
  const gz = Math.floor(flat / (d0 * d1));
  return {
    rows,
    depth,
    min0: gx / d0,
    max0: (gx + 1) / d0,
    min1: gy / d1,
    max1: (gy + 1) / d1,
    min2: gz / dims[2],
    max2: (gz + 1) / dims[2],
  };
}

function adaptiveVoxelChildFromSlot(group, rows, slot, mid0, mid1, mid2) {
  const hi0 = (slot & 1) !== 0;
  const hi1 = (slot & 2) !== 0;
  const hi2 = (slot & 4) !== 0;
  return {
    rows,
    depth: group.depth + 1,
    min0: hi0 ? mid0 : group.min0,
    max0: hi0 ? group.max0 : mid0,
    min1: hi1 ? mid1 : group.min1,
    max1: hi1 ? group.max1 : mid1,
    min2: hi2 ? mid2 : group.min2,
    max2: hi2 ? group.max2 : mid2,
  };
}

function buildInitialAdaptiveVoxels(rowCount, dims, cellCounts, pointFlats) {
  const groupKeys = [];
  const groupForFlat = new Int32Array(cellCounts.length);
  groupForFlat.fill(-1);
  const offsets = new Uint32Array(cellCounts.length + 1);
  for (let flat = 0; flat < cellCounts.length; flat++) {
    if (cellCounts[flat] > 0) {
      groupKeys.push(flat);
    }
    offsets[flat + 1] = offsets[flat] + cellCounts[flat];
  }

  const rowsByCell = new Int32Array(rowCount);
  const cursors = new Uint32Array(offsets);
  for (let row = 0; row < rowCount; row++) {
    const flat = pointFlats[row];
    rowsByCell[cursors[flat]++] = row;
  }

  const groups = [];
  for (const flat of groupKeys) {
    const groupIndex = groups.length;
    groupForFlat[flat] = groupIndex;
    groups.push(
      adaptiveVoxelFromGridCell(
        rowsByCell.subarray(offsets[flat], offsets[flat + 1]),
        dims,
        flat,
      ),
    );
  }
  return { groups, groupKeys, groupForFlat };
}

function splitAdaptiveVoxel(group, normalizedPositions) {
  const rowCount = group.rows.length;
  if (rowCount <= 1) {
    return null;
  }
  const mid0 = (group.min0 + group.max0) * 0.5;
  const mid1 = (group.min1 + group.max1) * 0.5;
  const mid2 = (group.min2 + group.max2) * 0.5;
  const counts = new Uint32Array(8);

  for (let i = 0; i < rowCount; i++) {
    const row = group.rows[i];
    const row3 = row * 3;
    const slot =
      (normalizedPositions[row3 + 0] >= mid0 ? 1 : 0) |
      (normalizedPositions[row3 + 1] >= mid1 ? 2 : 0) |
      (normalizedPositions[row3 + 2] >= mid2 ? 4 : 0);
    counts[slot] += 1;
  }

  let childCount = 0;
  for (let slot = 0; slot < 8; slot++) {
    if (counts[slot] > 0) {
      childCount += 1;
    }
  }
  if (childCount === 1) {
    const first = group.rows[0] * 3;
    const min = Array.from(normalizedPositions.subarray(first, first + 3));
    const max = min.slice();
    for (let i = 1; i < rowCount; i++) {
      const at = group.rows[i] * 3;
      for (let d = 0; d < 3; d++) {
        min[d] = Math.min(min[d], normalizedPositions[at + d]);
        max[d] = Math.max(max[d], normalizedPositions[at + d]);
      }
    }
    if (min.every((value, d) => value === max[d])) return null;

    // Skip single-child levels using point bounds, preserving octree cells.
    let cell = group;
    while (true) {
      const mid0 = (cell.min0 + cell.max0) * 0.5;
      const mid1 = (cell.min1 + cell.max1) * 0.5;
      const mid2 = (cell.min2 + cell.max2) * 0.5;
      if (
        (min[0] < mid0 && max[0] >= mid0) ||
        (min[1] < mid1 && max[1] >= mid1) ||
        (min[2] < mid2 && max[2] >= mid2)
      )
        return [cell];

      const slot =
        (min[0] >= mid0 ? 1 : 0) |
        (min[1] >= mid1 ? 2 : 0) |
        (min[2] >= mid2 ? 4 : 0);
      const child = adaptiveVoxelChildFromSlot(
        cell,
        group.rows,
        slot,
        mid0,
        mid1,
        mid2,
      );
      if (
        child.min0 === cell.min0 &&
        child.max0 === cell.max0 &&
        child.min1 === cell.min1 &&
        child.max1 === cell.max1 &&
        child.min2 === cell.min2 &&
        child.max2 === cell.max2
      )
        return null;
      cell = child;
    }
  }

  const childRows = new Array(8);
  const cursors = new Uint32Array(8);
  for (let slot = 0; slot < 8; slot++) {
    if (counts[slot] > 0) {
      childRows[slot] = new Int32Array(counts[slot]);
    }
  }
  for (let i = 0; i < rowCount; i++) {
    const row = group.rows[i];
    const row3 = row * 3;
    const slot =
      (normalizedPositions[row3 + 0] >= mid0 ? 1 : 0) |
      (normalizedPositions[row3 + 1] >= mid1 ? 2 : 0) |
      (normalizedPositions[row3 + 2] >= mid2 ? 4 : 0);
    childRows[slot][cursors[slot]++] = row;
  }

  const children = [];
  for (let slot = 0; slot < 8; slot++) {
    if (!childRows[slot]) {
      continue;
    }
    children.push(
      adaptiveVoxelChildFromSlot(
        group,
        childRows[slot],
        slot,
        mid0,
        mid1,
        mid2,
      ),
    );
  }
  return children;
}

function addAdaptiveVoxelNeighbor(neighborSets, lhs, rhs) {
  if (lhs === rhs) {
    return;
  }
  neighborSets[lhs].push(rhs);
  neighborSets[rhs].push(lhs);
}

function removeAdaptiveVoxelNeighbor(neighborSets, lhs, rhs) {
  const neighbors = neighborSets[lhs];
  const index = neighbors.indexOf(rhs);
  if (index < 0) {
    return;
  }
  const last = neighbors.length - 1;
  neighbors[index] = neighbors[last];
  neighbors.length = last;
}

function buildInitialAdaptiveVoxelNeighborSets(
  groups,
  groupKeys,
  groupForFlat,
  dims,
) {
  const neighborSets = Array.from({ length: groups.length }, () => []);
  const d0 = dims[0];
  const d1 = dims[1];
  const d2 = dims[2];
  for (let group = 0; group < groups.length; group++) {
    const key = groupKeys[group];
    const gx = key % d0;
    const gy = Math.floor(key / d0) % d1;
    const gz = Math.floor(key / (d0 * d1));
    for (let dz = -1; dz <= 1; dz++) {
      const nz = gz + dz;
      if (nz < 0 || nz >= d2) {
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= d1) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) {
            continue;
          }
          const nx = gx + dx;
          if (nx < 0 || nx >= d0) {
            continue;
          }
          const neighborFlat = nx + d0 * (ny + d1 * nz);
          const neighborGroup = groupForFlat[neighborFlat];
          if (neighborGroup > group) {
            addAdaptiveVoxelNeighbor(neighborSets, group, neighborGroup);
          }
        }
      }
    }
  }
  return neighborSets;
}

function replaceAdaptiveVoxelWithChildren(
  groupIndex,
  children,
  groups,
  neighborSets,
) {
  const childIndices = new Array(children.length);
  for (let i = 0; i < children.length; i++) {
    childIndices[i] = groups.length;
    groups.push(children[i]);
    neighborSets.push([]);
  }

  const oldNeighbors = neighborSets[groupIndex];
  for (const neighbor of oldNeighbors)
    removeAdaptiveVoxelNeighbor(neighborSets, neighbor, groupIndex);
  neighborSets[groupIndex] = [];

  for (let i = 0; i < childIndices.length; i++) {
    const lhsIndex = childIndices[i];
    const lhs = groups[lhsIndex];
    for (let j = i + 1; j < childIndices.length; j++) {
      const rhsIndex = childIndices[j];
      if (adaptiveVoxelsTouch(lhs, groups[rhsIndex])) {
        addAdaptiveVoxelNeighbor(neighborSets, lhsIndex, rhsIndex);
      }
    }
    for (const neighborIndex of oldNeighbors) {
      if (adaptiveVoxelsTouch(lhs, groups[neighborIndex])) {
        addAdaptiveVoxelNeighbor(neighborSets, lhsIndex, neighborIndex);
      }
    }
  }

  return childIndices;
}

function compactAdaptiveVoxelGroups(groups, neighborSets, leafGroupIndices) {
  const compactForGroup = new Int32Array(groups.length);
  compactForGroup.fill(-1);
  const compactGroups = new Array(leafGroupIndices.length);
  for (let group = 0; group < leafGroupIndices.length; group++) {
    const sourceGroup = leafGroupIndices[group];
    compactForGroup[sourceGroup] = group;
    compactGroups[group] = groups[sourceGroup];
  }

  const neighborGroupsByGroup = new Array(leafGroupIndices.length);
  for (let group = 0; group < leafGroupIndices.length; group++) {
    const sourceGroup = leafGroupIndices[group];
    const neighbors = [group];
    for (const sourceNeighbor of neighborSets[sourceGroup]) {
      const neighbor = compactForGroup[sourceNeighbor];
      if (neighbor >= 0) {
        neighbors.push(neighbor);
      }
    }
    neighbors.sort((lhs, rhs) => lhs - rhs);
    neighborGroupsByGroup[group] = neighbors;
  }

  return { groups: compactGroups, neighborGroupsByGroup };
}

function refineAdaptiveVoxels(
  initialGroups,
  initialNeighborSets,
  normalizedPositions,
  splitThreshold,
  maxGroupCount,
) {
  const groups = initialGroups;
  const neighborSets = initialNeighborSets;
  const leafGroupIndices = [];
  const stack = [];
  for (let group = initialGroups.length - 1; group >= 0; group--) {
    stack.push(group);
  }
  let activeGroupCount = initialGroups.length;

  while (stack.length > 0) {
    const groupIndex = stack.pop();
    const group = groups[groupIndex];
    if (
      group.rows.length > splitThreshold &&
      activeGroupCount < maxGroupCount
    ) {
      const children = splitAdaptiveVoxel(group, normalizedPositions);
      if (children && activeGroupCount + children.length - 1 <= maxGroupCount) {
        activeGroupCount += children.length - 1;
        const childIndices = replaceAdaptiveVoxelWithChildren(
          groupIndex,
          children,
          groups,
          neighborSets,
        );
        for (let i = childIndices.length - 1; i >= 0; i--) {
          stack.push(childIndices[i]);
        }
        continue;
      }
    }
    leafGroupIndices.push(groupIndex);
  }
  return compactAdaptiveVoxelGroups(groups, neighborSets, leafGroupIndices);
}

function buildAdaptiveVoxelIndex(groups, rowCount) {
  const groupOffsets = new Uint32Array(groups.length + 1);
  for (let group = 0; group < groups.length; group++) {
    groupOffsets[group + 1] = groupOffsets[group] + groups[group].rows.length;
  }
  const groupIndices = new Int32Array(rowCount);
  for (let group = 0; group < groups.length; group++) {
    groupIndices.set(groups[group].rows, groupOffsets[group]);
  }
  return { groupOffsets, groupIndices };
}

function adaptiveVoxelIntervalsTouch(aMin, aMax, bMin, bMax) {
  return (
    aMin <= bMax + ADAPTIVE_VOXEL_NEIGHBOR_EPSILON &&
    bMin <= aMax + ADAPTIVE_VOXEL_NEIGHBOR_EPSILON
  );
}

function adaptiveVoxelsTouch(a, b) {
  return (
    adaptiveVoxelIntervalsTouch(a.min0, a.max0, b.min0, b.max0) &&
    adaptiveVoxelIntervalsTouch(a.min1, a.max1, b.min1, b.max1) &&
    adaptiveVoxelIntervalsTouch(a.min2, a.max2, b.min2, b.max2)
  );
}

export {
  computeNormalizedPositions,
  chooseInitialAdaptiveVoxelGrid,
  buildInitialAdaptiveVoxels,
  buildInitialAdaptiveVoxelNeighborSets,
  refineAdaptiveVoxels,
  buildAdaptiveVoxelIndex,
};
