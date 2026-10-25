// LOD storage and merging adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import {
  HALF,
  SCALE,
  area,
  covariance,
  determinant,
  eigens,
  half,
  halfBits,
  opacityRadius,
  quaternion,
} from "./math.js";
import { Progress } from "./progress.js";
import { IndexArray, PagedArray, Permutation } from "./storage.js";

export const SH_DIMS = [9, 15, 21];

// What retain() finds a splat to be.
export const KEEP = 0;
export const INVALID = 1;
export const EMPTY = 2;
export const CROPPED = 3;
// A worker found a page that is not cached.
export const LATER = 4;

// Sets a record's feature size and area from its scales and opacity.
export function refresh(record) {
  const x = SCALE[halfBits(record[7])];
  const y = SCALE[halfBits(record[8])];
  const z = SCALE[halfBits(record[9])];
  record[14] = Math.fround(2 * Math.max(x, y, z) * opacityRadius(record[3]));
  record[15] = Math.fround(area(x, y, z));
}

// Whether a record has no negative opacity and no NaN or infinite values but
// zero scales (log scale -Infinity).
export function validRecord(record) {
  if (record[3] < 0) return false;
  for (let d = 0; d < 16; d++)
    if (
      !Number.isFinite(record[d]) &&
      !(d >= 7 && d <= 9 && record[d] === Number.NEGATIVE_INFINITY)
    )
      return false;
  return true;
}

// Classifies a valid record after refresh(), including optional cropping.
export function filterRecord(record, withinDist) {
  if (record[3] <= 0 || record[14] <= 0) return EMPTY;
  if (!withinDist) return KEEP;
  const [x, y, z, radius] = withinDist;
  return Math.hypot(record[0] - x, record[1] - y, record[2] - z) > radius
    ? CROPPED
    : KEEP;
}

export class Splats {
  constructor(workspace, maxSh) {
    this.workspace = workspace;
    this.maxSh = maxSh;
    this.inputSh = 0;
    this.length = 0;
    this.invalid = 0;
    this.cropped = 0;
    this.records = new PagedArray(workspace, Float32Array);
    this.sh = SH_DIMS.map(() => new PagedArray(workspace, Uint16Array));
    // The two children of the i-th merged splat are entries 2i and 2i + 1 of
    // `children`. Once buildLod() has laid out the tree, a splat's children
    // are the childCount consecutive rows from row childStart.
    this.childStart = new PagedArray(workspace, Float64Array);
    this.childCount = new IndexArray(workspace);
    this.children = new IndexArray(workspace);
    // Each splat's merge weight, area × opacity, which merge() reads instead
    // of two records.
    this.weight = new PagedArray(workspace, Float64Array);
    // The two child weights of each merged splat, for mergeSh().
    this.blend = new PagedArray(workspace, Float64Array);
    this.merged = new Float64Array(16);
    this.bits = new Uint16Array(0);
    this.merger = new Merger();
    this.shLeft = new Uint16Array(21);
    this.shRight = new Uint16Array(21);
  }

  receive(name, base, values) {
    if (name === "init") {
      if (base > 0x80000000)
        throw new Error("Input exceeds LOD u32 index limit");
      this.length = base;
      this.records.length = base * 16;
      this.inputSh = values[0];
      this.maxSh = Math.min(this.maxSh, this.inputSh, 3);
      for (let band = 0; band < this.maxSh; band++)
        this.sh[band].length = base * SH_DIMS[band];
      return;
    }
    if (!values.length) return;
    // `bits` is reused, so reading leaves no freed buffers behind.
    if (name.startsWith("sh")) {
      const band = Number(name[2]) - 1;
      if (band >= this.maxSh) return;
      if (this.bits.length < values.length)
        this.bits = new Uint16Array(values.length);
      for (let i = 0; i < values.length; i++)
        this.bits[i] = halfBits(values[i]);
      this.sh[band].write(base * SH_DIMS[band], this.bits, values.length);
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
    for (let i = 0; i < values.length / dims; i++) {
      const index = (base + i) * 16 + field;
      const page = this.records.page(index, true);
      const offset = index & this.records.mask;
      for (let d = 0; d < dims; d++) {
        const value =
          name === "scale"
            ? Math.log(values[i * dims + d])
            : values[i * dims + d];
        page[offset + d] = field === 0 ? value : half(value);
      }
    }
  }

  read(index, output) {
    return this.records.read(index * 16, output, 16);
  }
  feature(index) {
    return this.records.get(index * 16 + 14);
  }

  // Skips empty splats and counts invalid ones in `invalid`: NaN or infinite
  // values, including a zero rotation, which the decoder normalizes to NaN.
  // Optionally keeps only centers within [x, y, z, radius], counting the
  // otherwise usable splats outside this sphere in `cropped`.
  // Workers refresh, check and crop blocks of splats; the main thread
  // checks those they leave, and moves kept splats after skipped ones.
  retain(pool, withinDist) {
    const progress = new Progress("Filtering splats", this.length);
    const { results } = pool;
    const block = results.length;
    const record = new Float64Array(16);
    const rows = SH_DIMS.map((dims) => new Uint16Array(dims));
    const columns = [
      [this.records.share(), 16],
      ...this.sh
        .slice(0, this.maxSh)
        .map((column, band) => [column.share(), SH_DIMS[band]]),
    ];
    let count = 0;
    this.invalid = 0;
    this.cropped = 0;
    for (let base = 0; base < this.length; base += block) {
      const size = Math.min(block, this.length - base);
      for (const [column, stride] of columns)
        column.load(
          base * stride,
          (base + size) * stride,
          column === this.records,
        );
      pool.check(this, base, size, withinDist);
      for (let i = 0; i < size; i++) {
        const index = base + i;
        let state = results[i];
        const later = state === LATER;
        if (later) {
          this.read(index, record);
          refresh(record);
          state = !this.valid(index, record, rows)
            ? INVALID
            : filterRecord(record, withinDist);
        }
        if (state === INVALID) this.invalid++;
        if (state === CROPPED) this.cropped++;
        if (state !== KEEP) continue;
        if (count !== index || later) {
          if (!later) this.read(index, record);
          this.records.write(count * 16, record);
        }
        if (count !== index) {
          for (let band = 0; band < this.maxSh; band++) {
            const dims = SH_DIMS[band];
            this.sh[band].read(index * dims, rows[band]);
            this.sh[band].write(count * dims, rows[band]);
          }
        }
        count++;
      }
      progress.update(base + size);
    }
    this.length = count;
    this.records.length = count * 16;
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].length = count * SH_DIMS[band];
    progress.finish(`${count} usable splats`);
  }
  // Also reads the splat's SH coefficients into `rows`.
  valid(index, record, rows) {
    if (!validRecord(record)) return false;
    for (let band = 0; band < this.maxSh; band++) {
      const row = rows[band];
      this.sh[band].read(index * row.length, row);
      for (const bits of row) if (!Number.isFinite(HALF[bits])) return false;
    }
    return true;
  }

  // `ca` and `cb` are the Similarities terms of splats `a` and `b`, each
  // followed by its weight.
  merge(a, b, ca, cb) {
    const merger = this.merger;
    merger.run(ca, cb, ca[13], cb[13], this.merged);
    return this.append(a, b, this.merged, merger.w, merger.v);
  }

  // Adds the merge `out` of splats `a` and `b`, blended with weights w and v.
  append(a, b, out, w, v) {
    const index = this.length++;
    this.records.write(index * 16, out);
    this.weight.set(index, out[15] * out[3]);
    this.children.push(a);
    this.children.push(b);
    // SH coefficients do not affect merging; mergeSh() blends them later.
    if (this.maxSh) {
      this.blend.push(w);
      this.blend.push(v);
    }
    return index;
  }

  // Blends the SH coefficients of the splats merge() created from `initial`
  // on, in creation order, so children are done before their parents. Going
  // band by band keeps the random reads of children within one column.
  // Workers blend batches of splats whose children precede the batch; the
  // rest wait for their children in the batch.
  mergeSh(initial, pool) {
    const { nodes, entries, later, blends, blended, results } = pool;
    // Splats per batch.
    const size = later.length;
    const rows = [this.shLeft, this.shRight];
    for (let band = 0; band < this.maxSh; band++) {
      const progress = new Progress(
        `Blending SH${band + 1}`,
        this.length - initial,
      );
      const dims = SH_DIMS[band];
      const column = this.sh[band].share();
      for (let start = initial; start < this.length; start += size) {
        const count = Math.min(size, this.length - start);
        // Load the pages of the children's rows for the workers. Consecutive
        // splats' children often share pages; a page evicted meanwhile is a
        // miss that the main thread blends.
        let left = -1;
        let right = -1;
        for (let i = 0; i < count; i++) {
          const a = this.children.get((start + i - initial) * 2);
          const b = this.children.get((start + i - initial) * 2 + 1);
          nodes[i] = a;
          entries[i] = b;
          blends[i * 2] = this.blend.get((start + i - initial) * 2);
          blends[i * 2 + 1] = this.blend.get((start + i - initial) * 2 + 1);
          later[i] = Number(a >= start || b >= start);
          if (later[i]) continue;
          if (Math.floor((a * dims) / column.items) !== left) {
            left = Math.floor((a * dims) / column.items);
            column.page(a * dims);
          }
          if (Math.floor((b * dims) / column.items) !== right) {
            right = Math.floor((b * dims) / column.items);
            column.page(b * dims);
          }
        }
        pool.blend(column, count, dims);
        for (let i = 0; i < count; i++) {
          // A worker blended rows it marked 0.
          if (!later[i] && results[i] === 0) continue;
          for (let c = 0; c < 2; c++) {
            const child = c ? entries[i] : nodes[i];
            if (child < start) column.read(child * dims, rows[c], dims);
            else
              for (let d = 0; d < dims; d++)
                rows[c][d] = blended[(child - start) * dims + d];
          }
          const w = blends[i * 2];
          const v = blends[i * 2 + 1];
          for (let d = 0; d < dims; d++)
            blended[i * dims + d] = halfBits(
              HALF[this.shLeft[d]] * w + HALF[this.shRight[d]] * v,
            );
        }
        column.write(start * dims, blended, count * dims);
        progress.update(start + count - initial);
      }
      progress.finish();
    }
    this.blend.dispose();
  }

  // Moves row indices[i] of the records and SH to row i.
  reorder(indices, pool) {
    const permutation = new Permutation(
      this.workspace,
      indices,
      this.length,
      "Preparing splat order",
    );
    this.records = permutation.apply(
      this.records,
      16,
      pool,
      false,
      "Reordering splats",
    );
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band] = permutation.apply(
        this.sh[band],
        SH_DIMS[band],
        pool,
        false,
        `Reordering SH${band + 1}`,
      );
    permutation.dispose();
    this.length = indices.length;
  }

  dispose() {
    for (const column of [
      this.records,
      ...this.sh,
      this.childStart,
      this.childCount,
      this.children,
      this.weight,
      this.blend,
    ])
      column.dispose();
  }
}

// Merges two splats, given their Similarities terms `ca` and `cb` and
// weights (area × opacity), into the record `out`; `w` and `v` are then their
// blend weights.
export class Merger {
  constructor() {
    this.cov = new Float64Array(6);
    this.matrix = new Float64Array(9);
    this.vectors = new Float64Array(9);
    this.rotation = new Float64Array(9);
    this.axes = new Uint8Array(3);
    this.w = 0;
    this.v = 0;
  }
  run(ca, cb, wa, wb, out) {
    const total = Math.max(wa + wb, 1e-30);
    const w = wa / total;
    const v = wb / total;
    this.w = w;
    this.v = v;
    for (let d = 0; d < 3; d++) {
      out[d] = Math.fround(ca[d] * w + cb[d] * v);
      out[4 + d] = half(ca[3 + d] * w + cb[3 + d] * v);
    }
    const ax = ca[0] - out[0];
    const ay = ca[1] - out[1];
    const az = ca[2] - out[2];
    const bx = cb[0] - out[0];
    const by = cb[1] - out[1];
    const bz = cb[2] - out[2];
    const cov = this.cov;
    cov[0] = (ca[6] + ax * ax) * w + (cb[6] + bx * bx) * v;
    cov[1] = (ca[7] + ay * ay) * w + (cb[7] + by * by) * v;
    cov[2] = (ca[8] + az * az) * w + (cb[8] + bz * bz) * v;
    cov[3] = (ca[9] + ax * ay) * w + (cb[9] + bx * by) * v;
    cov[4] = (ca[10] + ax * az) * w + (cb[10] + bx * bz) * v;
    cov[5] = (ca[11] + ay * az) * w + (cb[11] + by * bz) * v;
    for (const value of cov)
      if (!Number.isFinite(value)) throw new Error("LOD covariance overflow");
    eigens(cov, this.matrix, this.vectors, this.axes);
    const r = this.rotation;
    for (let col = 0; col < 3; col++) {
      const axis = this.axes[col];
      const norm = Math.hypot(
        this.vectors[axis],
        this.vectors[3 + axis],
        this.vectors[6 + axis],
      );
      for (let row = 0; row < 3; row++)
        r[col * 3 + row] = this.vectors[row * 3 + axis] / norm;
      out[7 + col] = Math.max(
        1e-30,
        Math.sqrt(Math.max(0, this.matrix[axis * 3 + axis])),
      );
    }
    if (
      r[0] * (r[4] * r[8] - r[5] * r[7]) -
        r[3] * (r[1] * r[8] - r[2] * r[7]) +
        r[6] * (r[1] * r[5] - r[2] * r[4]) <
      0
    ) {
      r[6] *= -1;
      r[7] *= -1;
      r[8] *= -1;
    }
    out[3] = half(
      Math.max(0.000001, Math.min(1000, total / area(out[7], out[8], out[9]))),
    );
    for (let d = 7; d <= 9; d++) out[d] = half(Math.log(out[d]));
    quaternion(r, out);
    for (let d = 10; d <= 13; d++) out[d] = half(out[d]);
    refresh(out);
    if (!Number.isFinite(out[14]) || !Number.isFinite(out[15]))
      throw new Error("LOD scale overflow");
  }
}

export class Similarities {
  constructor(splats) {
    this.splats = splats;
    this.record = new Float64Array(16);
    this.cov = new Float64Array(6);
    this.rotation = new Float64Array(9);
  }
  // The terms of splat `index`, then its weight as merge() sets it.
  get(index, out) {
    const record = this.splats.read(index, this.record);
    this.terms(record, out);
    out[13] = record[15] * record[3];
    return out;
  }
  // The terms of `record`: center, color, covariance and log determinant.
  terms(record, out) {
    covariance(record, this.cov, this.rotation);
    for (let d = 0; d < 3; d++) {
      out[d] = record[d];
      out[3 + d] = record[4 + d];
    }
    for (let d = 0; d < 6; d++) out[6 + d] = Math.fround(this.cov[d]);
    out[12] = Math.fround(0.25 * Math.log(determinant(this.cov)));
    return out;
  }
}
