import { POSITION_BATCH_ROWS as BATCH } from "./lod-config.js";

// The centers of the splats of `levels`, one level after another, three
// values a row, read from the levels' own centers, and `box`, the box of
// all of them.
export class Positions {
  constructor({ levels, length, starts }) {
    this.length = length;
    this.levels = levels;
    this.starts = starts;
    const min = [0, 1, 2].map(() => Number.POSITIVE_INFINITY);
    const max = [0, 1, 2].map(() => Number.NEGATIVE_INFINITY);
    for (const level of levels) {
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

  // Visit the centers in global row order and release them on this final pass.
  consume(visit) {
    const values = new Float32Array(BATCH * 3);
    for (const [i, level] of this.levels.entries()) {
      for (let row = 0; row < level.length; row += BATCH) {
        const count = Math.min(BATCH, level.length - row);
        level.centers.consume(row * 3, values, count * 3);
        visit(values, count, this.starts[i] + row);
      }
      level.centers.dispose();
    }
  }
}
