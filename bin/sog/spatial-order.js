export function divide(node, middle) {
  node.children = [
    { start: node.start, count: middle - node.start },
    { start: middle, count: node.start + node.count - middle },
  ];
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
