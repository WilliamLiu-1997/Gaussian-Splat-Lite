import { rank, sortItems } from "../rad/heap.js";
import { Progress } from "../rad/progress.js";
import { IndexArray, PagedArray } from "../rad/storage.js";

// Density balances the initiating child's size against the merge's leaf count.
// Each node stores its first level and the number of coarser levels that omit it.
export function selectLevels(tree, leaves, targets, density) {
  const { workspace, children, sizes } = tree;
  const merges = tree.length - leaves;
  const levels = targets.length;
  const ranges = new PagedArray(
    workspace,
    levels <= 255 ? Uint8Array : Uint32Array,
    tree.length * 2,
  );
  const counts = new IndexArray(workspace);
  const items = new IndexArray(workspace);
  let sorted;
  try {
    const progress = new Progress("Ranking SOG merges", merges);
    for (let merge = 0; merge < merges; merge++) {
      if ((merge & 4095) === 0) progress.update(merge);
      let count = 0;
      let childLimit = 0xffffffff;
      for (let c = 0; c < 2; c++) {
        const child = children.get(merge * 2 + c);
        if (child < leaves) count++;
        else {
          const childMerge = child - leaves;
          childLimit = Math.min(childLimit, items.get(childMerge * 2));
          count += counts.get(childMerge);
        }
      }
      const size = sizes.get(children.get(merge * 2));
      const score = size ** (1 - density) * count ** (density / 2);
      counts.set(merge, count);
      // Keys sort descending. A parent can tie its children but must follow them.
      items.push(Math.min(childLimit, rank(-score)));
      items.push(merge);
      // Until a level takes it, a merge is in no level.
      ranges.set((leaves + merge) * 2, levels);
    }
    progress.finish();
    counts.dispose();
    sorted = sortItems(items, merges, workspace, true, "Sorting SOG merges");
    items.dispose();

    let selected = 0;
    for (let level = 0; level < levels; level++)
      for (; selected < leaves - targets[level]; selected++) {
        const merge = sorted.get(selected * 2 + 1);
        ranges.set((leaves + merge) * 2, level);
        for (let c = 0; c < 2; c++)
          ranges.set(children.get(merge * 2 + c) * 2 + 1, levels - level);
      }
    return ranges;
  } catch (error) {
    counts.dispose();
    items.dispose();
    ranges.dispose();
    throw error;
  } finally {
    sorted?.dispose();
  }
}
