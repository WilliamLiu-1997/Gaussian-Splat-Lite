import { Centers, Order, divide } from "../spatial-order.js";
import { boundsOf, splitRange } from "../spatial.js";

// Each remaining KD level scans the rows in its subtree.
function indexWork({ count, quota }) {
  return count * (1 + Math.log2(quota));
}

export function buildCoverageIndex(cloud, groupCount, check, report) {
  const { positions, length: count } = cloud;
  const groupIndices = Int32Array.from({ length: count }, (_, row) => row);
  const groupOffsets = new Uint32Array(groupCount + 1);
  const rows = new Centers(positions, check);
  const order = new Order(groupIndices);
  const pending = [{ start: 0, count, quota: groupCount }];
  const nodes = [];
  let group = 0;
  let done = 0;
  const workPerRow = 1 + Math.log2(groupCount);

  while (pending.length) {
    check();
    const part = pending.pop();
    const { start, count, quota } = part;
    const { min, max } = boundsOf(rows, order, start, count);
    if (quota === 1) {
      order.sort(start, count);
      groupOffsets[group + 1] = start + count;
      nodes.push({ min, max, group: group++ });
      done += count;
      report?.(done / workPerRow);
      continue;
    }

    // A binary subtree with quota leaves occupies 2 * quota - 1 nodes.
    const end = nodes.length + 2 * quota - 1;
    nodes.push({ min, max, group: -1, end });
    divide(part, splitRange(rows, order, start, count, { min, max }));
    const [left, right] = part.children;
    if (report) {
      done += indexWork(part) - indexWork(left) - indexWork(right);
      report(done / workPerRow);
    }
    pending.push(right, left);
  }

  const groups = [];
  function groupsFor(row, radius) {
    const x = positions[row * 3];
    const y = positions[row * 3 + 1];
    const z = positions[row * 3 + 2];
    const x0 = x - radius;
    const x1 = x + radius;
    const y0 = y - radius;
    const y1 = y + radius;
    const z0 = z - radius;
    const z1 = z + radius;
    groups.length = 0;
    for (let i = 0; i < nodes.length; ) {
      const { min, max, group, end } = nodes[i++];
      if (
        x1 < min[0] ||
        x0 > max[0] ||
        y1 < min[1] ||
        y0 > max[1] ||
        z1 < min[2] ||
        z0 > max[2]
      ) {
        if (group < 0) i = end;
      } else if (group >= 0) {
        const dx = Math.max(0, x - max[0], min[0] - x);
        const dy = Math.max(0, y - max[1], min[1] - y);
        const dz = Math.max(0, z - max[2], min[2] - z);
        if (dx * dx + dy * dy + dz * dz <= radius * radius) groups.push(group);
      }
    }
    return groups;
  }
  return { groupOffsets, groupIndices, groupsFor, nodes };
}
