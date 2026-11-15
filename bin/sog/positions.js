// Rows read at a time.
export const BATCH = 16384;

// The centers of the splats of `levels`, one level after another, three
// values a row, read from the levels' own centers, and `box`, the box of
// all of them.
export class Positions {
  constructor(levels, length) {
    this.length = length;
    this.levels = levels;
    this.starts = [];
    let start = 0;
    const min = [0, 1, 2].map(() => Number.POSITIVE_INFINITY);
    const max = [0, 1, 2].map(() => Number.NEGATIVE_INFINITY);
    for (const level of levels) {
      this.starts.push(start);
      start += level.length;
      for (let d = 0; d < 3; d++) {
        min[d] = Math.min(min[d], level.box.min[d]);
        max[d] = Math.max(max[d], level.box.max[d]);
      }
    }
    this.box = { min, max };
  }

  // Reads the centers of `rows` rows from row `base`, three values a row.
  read(base, values, rows) {
    let level = this.starts.length - 1;
    while (this.starts[level] > base) level--;
    for (let done = 0; done < rows; level++) {
      const start = this.starts[level];
      const row = base + done;
      const count = Math.min(
        rows - done,
        start + this.levels[level].length - row,
      );
      this.levels[level].centers.read(
        (row - start) * 3,
        values,
        count * 3,
        done * 3,
      );
      done += count;
    }
    return values;
  }

  // Calls `visit(values, count, base)` with the centers of every batch of
  // rows in order: three values a row, `count` rows from row `base`.
  scan(visit) {
    const values = new Float32Array(BATCH * 3);
    for (let base = 0; base < this.length; base += BATCH) {
      const count = Math.min(BATCH, this.length - base);
      this.read(base, values, count);
      visit(values, count, base);
    }
  }
}
