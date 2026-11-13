import { Progress } from "../rad/progress.js";
import { PagedArray } from "../rad/storage.js";

export const SH_DIMS = [9, 15, 21, 27];
export const SH_C0 = 0.28209479177387814;
// Splats that retain() checks at a time.
const CHECKED = 16384;

// Position, raw mass, RGB, log scale, XYZW rotation; two alignment words.
export class Splats {
  constructor(workspace, maxSh) {
    this.workspace = workspace;
    this.maxSh = maxSh;
    this.inputSh = maxSh;
    this.rawMass = true;
    this.length = 0;
    this.records = new PagedArray(workspace, Float32Array);
    this.sh = SH_DIMS.map(() => new PagedArray(workspace, Float32Array));
  }

  receive(name, base, values) {
    if (name === "init") {
      if (base > 0xffffffff) throw new Error("Input exceeds u32 index limit");
      this.length = base;
      this.records.length = base * 16;
      this.inputSh = values[0];
      this.maxSh = Math.min(this.maxSh, this.inputSh);
      for (let band = 0; band < this.maxSh; band++)
        this.sh[band].length = base * SH_DIMS[band];
      return;
    }
    if (!values.length) return;
    if (name.startsWith("sh")) {
      const band = Number(name[2]) - 1;
      if (band < this.maxSh) this.sh[band].write(base * SH_DIMS[band], values);
      return;
    }
    const [field, dims] = {
      center: [0, 3],
      opacity: [3, 1],
      rgb: [4, 3],
      scale: [7, 3],
      lnScale: [7, 3],
      quat: [10, 4],
    }[name];
    // A page holds whole records: one look at it serves all the splats that
    // lie on it.
    const { records } = this;
    const count = values.length / dims;
    for (let i = 0; i < count; ) {
      const index = (base + i) * 16 + field;
      const page = records.page(index, true);
      let offset = index & records.mask;
      const end = Math.min(count, i + ((records.items - offset + 15) >> 4));
      for (; i < end; i++, offset += 16) {
        const at = i * dims;
        if (name === "quat") {
          // Rotations are stored at unit length; one without a length stays
          // as it is, for retain() to remove its splat.
          const q = Math.hypot(
            values[at],
            values[at + 1],
            values[at + 2],
            values[at + 3],
          );
          const length = q > 0 && Number.isFinite(q) ? q : 1;
          for (let d = 0; d < 4; d++)
            page[offset + d] = values[at + d] / length;
        } else if (name === "scale")
          for (let d = 0; d < dims; d++)
            page[offset + d] = Math.log(values[at + d]);
        else for (let d = 0; d < dims; d++) page[offset + d] = values[at + d];
      }
    }
  }

  read(index, record) {
    return this.records.read(index * 16, record, 16);
  }

  // Reads `count` splats from `start` into `records` and an array per band.
  load(start, count, records, sh) {
    this.records.read(start * 16, records, count * 16);
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].read(
        start * SH_DIMS[band],
        sh[band],
        count * SH_DIMS[band],
      );
  }

  // Writes `count` splats at `start`; blocks may arrive in any order.
  store(start, count, records, sh) {
    this.records.write(start * 16, records, count * 16);
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].write(
        start * SH_DIMS[band],
        sh[band],
        count * SH_DIMS[band],
      );
    this.length = Math.max(this.length, start + count);
  }

  // Removes the splats that cannot be drawn: those with a value that is not
  // finite, without a rotation, with negative opacity or with a scale that
  // single precision does not hold, and those with no opacity. Splats are
  // checked a block at a time and written only from the first one removed.
  retain(withinDist) {
    const { maxSh, length } = this;
    const records = new Float32Array(CHECKED * 16);
    const sh = SH_DIMS.map(
      (size, band) => new Float32Array(band < maxSh ? CHECKED * size : 0),
    );
    const progress = new Progress("Checking splats", length);
    let kept = 0;
    let invalid = 0;
    let cropped = 0;
    for (let start = 0; start < length; start += CHECKED) {
      const count = Math.min(CHECKED, length - start);
      this.load(start, count, records, sh);
      // The block's splats that stay, moved to its front.
      let stay = 0;
      for (let i = 0; i < count; i++) {
        const at = i * 16;
        let valid = records[at + 3] >= 0;
        for (let d = 0; d < 14; d++) valid &&= Number.isFinite(records[at + d]);
        for (let band = 0; valid && band < maxSh; band++) {
          const size = SH_DIMS[band];
          const row = sh[band];
          for (let d = i * size; d < (i + 1) * size; d++)
            valid &&= Number.isFinite(row[d]);
        }
        valid &&=
          Math.hypot(
            records[at + 10],
            records[at + 11],
            records[at + 12],
            records[at + 13],
          ) > 0;
        for (let d = 7; d < 10; d++) {
          const scale = Math.exp(records[at + d]);
          valid &&= scale > 0 && Number.isFinite(Math.fround(scale));
        }
        if (!valid) {
          invalid++;
          continue;
        }
        if (!records[at + 3]) continue;
        if (
          withinDist &&
          Math.hypot(
            records[at] - withinDist[0],
            records[at + 1] - withinDist[1],
            records[at + 2] - withinDist[2],
          ) > withinDist[3]
        ) {
          cropped++;
          continue;
        }
        if (stay !== i) {
          records.copyWithin(stay * 16, at, at + 16);
          for (let band = 0; band < maxSh; band++) {
            const size = SH_DIMS[band];
            sh[band].copyWithin(stay * size, i * size, (i + 1) * size);
          }
        }
        stay++;
      }
      if (kept !== start || stay !== count) this.store(kept, stay, records, sh);
      kept += stay;
      progress.update(start + count);
    }
    progress.finish();
    this.length = kept;
    this.records.length = kept * 16;
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].length = kept * SH_DIMS[band];
    if (kept !== length)
      console.log(
        `Kept ${kept} splats; removed ${invalid} invalid and ${length - kept - invalid - cropped} empty splats`,
      );
    if (cropped) console.log(`Removed ${cropped} splats outside --within-dist`);
    if (!kept) throw new Error("Input has no usable splats");
  }

  dispose() {
    this.records.dispose();
    for (const band of this.sh) band.dispose();
  }
}
