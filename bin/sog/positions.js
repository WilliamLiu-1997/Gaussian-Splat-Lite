import { PagedArray } from "../rad/storage.js";

// Rows read at a time.
export const BATCH = 16384;

// The centers of the splats of `levels`, one level after another. Spatial
// scans should not pull color, scale and rotation pages into the cache.
// `advance(rows)` hears of the rows as they are read.
export class Positions {
  constructor(workspace, levels, length, advance) {
    this.length = length;
    this.data = new PagedArray(workspace, Float32Array, length * 4);
    const records = new Float32Array(BATCH * 16);
    const values = new Float32Array(BATCH * 4);
    try {
      let row = 0;
      for (const level of levels)
        for (let base = 0; base < level.length; base += BATCH) {
          const count = Math.min(BATCH, level.length - base);
          level.records.read(base * 16, records, count * 16);
          for (let i = 0; i < count; i++)
            for (let d = 0; d < 3; d++) values[i * 4 + d] = records[i * 16 + d];
          this.data.write(row * 4, values, count * 4);
          row += count;
          advance(count);
        }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  // Reads the centers of `rows` rows from row `base`, four values a row.
  read(base, values, rows) {
    return this.data.read(base * 4, values, rows * 4);
  }

  // Calls `visit(values, count, base)` with the centers of every batch of
  // rows in order: four values a row, `count` rows from row `base`.
  scan(visit) {
    const values = new Float32Array(BATCH * 4);
    for (let base = 0; base < this.length; base += BATCH) {
      const count = Math.min(BATCH, this.length - base);
      this.data.read(base * 4, values, count * 4);
      visit(values, count, base);
    }
  }

  dispose() {
    this.data.dispose();
  }
}
