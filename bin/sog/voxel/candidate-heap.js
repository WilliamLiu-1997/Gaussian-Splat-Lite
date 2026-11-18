// A cached priority can only decrease as representatives are added. Only the
// root needs its score refreshed before it can be selected.
export class CandidateHeap {
  constructor(rows, before) {
    this.rows = rows;
    this.length = rows.length;
    this.before = before;
    for (let i = (rows.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  pop() {
    this.rows[0] = this.rows[--this.length];
    this.siftDown(0);
  }

  siftDown(start) {
    let index = start;
    const { rows, length, before } = this;
    const row = rows[index];
    while (index * 2 + 1 < length) {
      let child = index * 2 + 1;
      if (child + 1 < length && before(rows[child + 1], rows[child])) child++;
      if (!before(rows[child], row)) break;
      rows[index] = rows[child];
      index = child;
    }
    rows[index] = row;
  }
}
