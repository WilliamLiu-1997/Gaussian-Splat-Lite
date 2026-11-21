import { MIN_ASPECT, SCALE, area, halfBits } from "../rad/math.js";
import { Progress } from "../rad/progress.js";
import { PagedArray } from "../rad/storage.js";
import { BlindInput } from "./blind.js";
import { plyMetadata } from "./comments.js";

export const SH_DIMS = [9, 15, 21, 27];
export const SH_C0 = 0.28209479177387814;
// Splats that retain() checks at a time.
const CHECKED = 16384;
// The centers of the splats that store() writes, kept from call to call: as
// garbage, each call's would take room from the cache.
let stored = new Float32Array(0);

// Position, raw mass, RGB, log scale, XYZW rotation; Blind row as two u16s.
export class Splats {
  // With `filter`, retain() crops the splats to its `withinDist`.
  constructor(workspace, maxSh, filter = undefined) {
    this.workspace = workspace;
    // What retain() checks as the splats' fields arrive: the crop, the
    // fields that every splat needs and how far each has arrived, the
    // splats checked, and the first `kept` of them, which stay.
    this.withinDist = filter?.withinDist;
    this.blind = filter?.blind?.length
      ? new BlindInput(workspace, filter.blind, CHECKED)
      : undefined;
    this.fields = [];
    this.received = {};
    this.checked = 0;
    this.kept = 0;
    this.invalid = 0;
    this.cropped = 0;
    this.block = undefined;
    this.maxSh = maxSh;
    this.inputSh = maxSh;
    this.rawMass = true;
    this.length = 0;
    this.records = new PagedArray(workspace, Float32Array);
    this.sh = SH_DIMS.map(() => new PagedArray(workspace, Uint16Array));
    // The splats' centers apart from their records, three values a row, for
    // the splits that read nothing else, and the box of the centers of the
    // splats that stay.
    this.centers = new PagedArray(workspace, Float32Array);
    this.box = {
      min: [0, 1, 2].map(() => Number.POSITIVE_INFINITY),
      max: [0, 1, 2].map(() => Number.NEGATIVE_INFINITY),
    };
  }

  receive(name, base, values) {
    if (name === "ply") {
      Object.assign(this, plyMetadata(values));
      return;
    }
    if (name === "blind") {
      // Blind arrives before each geometry batch; consume the previous tail
      // before its raw values are replaced.
      if (this.checked < base) this.check(base - this.checked);
      this.blind.receive(base, values);
      return;
    }
    if (name === "init") {
      if (base > 0xffffffff) throw new Error("Input exceeds u32 index limit");
      this.inputSh = values[0];
      this.maxSh = Math.min(this.maxSh, this.inputSh);
      this.resize(base);
      this.fields = ["center", "opacity", "rgb", "scale", "quat"];
      for (let band = 0; band < this.maxSh; band++)
        this.fields.push(`sh${band + 1}`);
      return;
    }
    if (!values.length) return;
    if (name.startsWith("sh")) {
      const band = Number(name[2]) - 1;
      if (band >= this.maxSh) return;
      this.sh[band].write(base * SH_DIMS[band], values);
      this.arrived(name, base + values.length / SH_DIMS[band]);
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
    if (name === "center") this.centers.write(base * 3, values);
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
    this.arrived(name === "lnScale" ? "scale" : name, base + count);
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

  resize(count) {
    this.length = count;
    this.records.length = count * 16;
    this.centers.length = count * 3;
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].length = count * SH_DIMS[band];
  }

  // Write the splats and update their center column and bounds.
  store(start, count, records, sh) {
    this.records.write(start * 16, records, count * 16);
    if (stored.length < count * 3) stored = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      for (let d = 0; d < 3; d++) stored[i * 3 + d] = records[i * 16 + d];
    this.centers.write(start * 3, stored, count * 3);
    this.grow(records, count);
    this.length = Math.max(this.length, start + count);

    if (!sh) return;
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].write(
        start * SH_DIMS[band],
        sh[band],
        count * SH_DIMS[band],
      );
  }

  // Grows the box by the centers of the first `count` of `records`.
  grow(records, count) {
    const { min, max } = this.box;
    for (let i = 0; i < count; i++)
      for (let d = 0; d < 3; d++) {
        const value = records[i * 16 + d];
        min[d] = Math.min(min[d], value);
        max[d] = Math.max(max[d], value);
      }
  }

  // Removes the splats that cannot be drawn: those with a value that is not
  // finite (except zero scales), without a rotation, with negative opacity or
  // with an area or squared scale that single precision does not hold, and
  // those with no opacity or extent. Most are checked as their fields arrive.
  retain() {
    const { length } = this;
    if (this.checked < length) {
      const progress = new Progress("Checking splats", length - this.checked);
      const from = this.checked;
      while (this.checked < length) {
        this.check(Math.min(CHECKED, length - this.checked));
        progress.update(this.checked - from);
      }
      progress.finish();
    }
    this.block = undefined;
    const { kept, invalid, cropped } = this;
    this.resize(kept);
    if (kept !== length)
      console.log(
        `Kept ${kept} splats; removed ${invalid} invalid and ${length - kept - invalid - cropped} empty splats`,
      );
    if (cropped) console.log(`Removed ${cropped} splats outside --within-dist`);
    if (!kept) throw new Error("Input has no usable splats");
    if (this.blind?.automatic.length)
      this.blind.resolveLayout(this.blind.maxima);
  }

  // Notes that the splats before `end` have `field`, and checks those that
  // have every field, a block at a time while their pages are cached.
  arrived(field, end) {
    this.received[field] = Math.max(this.received[field] ?? 0, end);
    let complete = this.length;
    for (const key of this.fields)
      complete = Math.min(complete, this.received[key] ?? 0);
    while (complete - this.checked >= CHECKED) this.check(CHECKED);
  }

  // Checks the next `count` splats, and moves those that stay after the
  // splats kept so far.
  check(count) {
    const { maxSh, withinDist, blind } = this;
    this.block ??= {
      records: new Float32Array(CHECKED * 16),
      sh: SH_DIMS.map(
        (size, band) => new Uint16Array(band < maxSh ? CHECKED * size : 0),
      ),
    };
    const { records, sh } = this.block;
    const start = this.checked;
    this.load(start, count, records, sh);
    // The block's splats that stay, moved to its front.
    let stay = 0;
    let rewritten = false;
    for (let i = 0; i < count; i++) {
      const at = i * 16;
      let valid = records[at + 3] >= 0;
      // As in RAD, a zero scale (log scale -Infinity) is valid.
      for (let d = 0; d < 14; d++)
        valid &&=
          Number.isFinite(records[at + d]) ||
          (d >= 7 && d <= 9 && records[at + d] === Number.NEGATIVE_INFINITY);
      // The written SH0 must hold in single precision too.
      for (let d = at + 4; d < at + 7; d++)
        valid &&= Number.isFinite(Math.fround((records[d] - 0.5) / SH_C0));
      for (let band = 0; valid && band < maxSh; band++) {
        const size = SH_DIMS[band];
        const row = sh[band];
        // A half with all exponent bits set is not finite.
        for (let d = i * size; d < (i + 1) * size; d++)
          valid &&= (row[d] & 0x7c00) !== 0x7c00;
      }
      valid &&=
        Math.hypot(
          records[at + 10],
          records[at + 11],
          records[at + 12],
          records[at + 13],
        ) > 0;
      const x = SCALE[halfBits(records[at + 7])];
      const y = SCALE[halfBits(records[at + 8])];
      const z = SCALE[halfBits(records[at + 9])];
      const maxScale = Math.max(x, y, z);
      // Zero axes take the thinnest merged extent, so codebooks stay finite.
      let zeroAxisScale = 0;
      if (maxScale > 0 && !(x && y && z)) {
        const thin = Math.log(maxScale * MIN_ASPECT);
        if (!x) records[at + 7] = thin;
        if (!y) records[at + 8] = thin;
        if (!z) records[at + 9] = thin;
        zeroAxisScale = SCALE[halfBits(thin)];
        rewritten = true;
      }
      // Merge weights and covariances use Float32 areas and variances.
      const surface = area(
        x || zeroAxisScale,
        y || zeroAxisScale,
        z || zeroAxisScale,
      );
      valid &&=
        Number.isFinite(Math.fround(maxScale * maxScale)) &&
        Number.isFinite(Math.fround(surface));
      if (!valid) {
        this.invalid++;
        continue;
      }
      // As in RAD, a splat without opacity or extent is empty.
      if (!records[at + 3] || !maxScale) continue;
      if (
        withinDist &&
        Math.hypot(
          records[at] - withinDist[0],
          records[at + 1] - withinDist[1],
          records[at + 2] - withinDist[2],
        ) > withinDist[3]
      ) {
        this.cropped++;
        continue;
      }
      blind?.keep(start + i, stay);
      if (stay !== i) {
        records.copyWithin(stay * 16, at, at + 16);
        for (let band = 0; band < maxSh; band++) {
          const size = SH_DIMS[band];
          sh[band].copyWithin(stay * size, i * size, (i + 1) * size);
        }
      }
      stay++;
    }
    blind?.flush(this.kept, stay);
    if (this.kept !== start || stay !== count) {
      this.store(this.kept, stay, records, sh);
    } else {
      if (rewritten) this.records.write(start * 16, records, stay * 16);
      this.grow(records, stay);
    }
    this.kept += stay;
    this.checked += count;
  }

  dispose() {
    this.blind?.dispose();
    this.records.dispose();
    this.centers.dispose();
    for (const band of this.sh) band.dispose();
  }
}
