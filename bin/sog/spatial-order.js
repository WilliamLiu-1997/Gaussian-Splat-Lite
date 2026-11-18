// Gives `node` its two children at `middle`, and with a quota, theirs in
// proportion to their counts.
export function divide(node, middle) {
  const { start, count, quota } = node;
  const left = middle - start;
  const right = count - left;
  node.children = [
    { start, count: left },
    { start: middle, count: right },
  ];
  if (quota === undefined) return;
  const a =
    quota === 1
      ? 1
      : Math.max(
          1,
          quota - right,
          Math.min(left, quota - 1, Math.round((quota * left) / count)),
        );
  node.children[0].quota = a;
  node.children[1].quota = Math.max(1, quota - a);
}

// Centers in memory, read as splitRange() reads rows. Polls for
// cancellation as the paged arrays do.
export class Centers {
  constructor(values, check) {
    this.values = values;
    this.check = check;
    this.reads = 0;
  }

  read(index, record) {
    if ((++this.reads & 0xfffff) === 0) this.check();
    const at = index * 3;
    record[0] = this.values[at];
    record[1] = this.values[at + 1];
    record[2] = this.values[at + 2];
    return record;
  }
}

// The order of rows in memory, with what splitRange() uses of an
// IndexArray.
export class Order {
  constructor(values) {
    this.values = values;
  }

  get(index) {
    return this.values[index];
  }

  set(index, value) {
    this.values[index] = value;
  }

  sort(start, count) {
    this.values.subarray(start, start + count).sort();
  }
}
