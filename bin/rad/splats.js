// LOD storage and merging adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import {
  HALF,
  MIN_ASPECT,
  SCALE,
  area,
  covariance,
  determinant,
  eigens,
  half,
  halfArray,
  halfBits,
  opacityRadius,
  quaternion,
} from "./math.js";
import { Progress } from "./progress.js";
import { IndexArray, PAGE_BYTES, PagedArray, Permutation } from "./storage.js";

export const SH_DIMS = [9, 15, 21];
// One SH code per eight rows unless a size is requested, capped at the
// row count and 256K entries.
export const shCodeCount = (count, entries) =>
  Math.min(count, 262144, entries ?? Math.ceil(count / 8));
// Words of a splat's shape, what chunkTree() reads of its record: the
// center as three floats, then the half bits of the log scales and the
// rotation, two to a word. All but the center are half values; see receive()
// and Merger.run().
export const SHAPE_WORDS = 7;
// Consecutive splats whose shapes are written at a time.
const SHAPE_BLOCK = 4096;

// What retain() finds a splat to be.
export const KEEP = 0;
export const INVALID = 1;
export const EMPTY = 2;
export const CROPPED = 3;
// A worker found a page that is not cached.
export const LATER = 4;

// Set feature size and area. For a parent, preserve its children's combined
// weight using the area of the stored shape.
export function refresh(record, at = 0, weight = undefined) {
  const x = SCALE[halfBits(record[at + 7])];
  const y = SCALE[halfBits(record[at + 8])];
  const z = SCALE[halfBits(record[at + 9])];
  const surface = area(x, y, z);
  if (weight !== undefined) record[at + 3] = Math.fround(weight / surface);
  record[at + 15] = Math.fround(surface);
  record[at + 14] = Math.fround(
    2 * Math.max(x, y, z) * opacityRadius(record[at + 3]),
  );
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
  // `filter.start(count)` creates the Pool once the decoder knows the count;
  // arrived() checks complete batches with `filter.withinDist` as the crop.
  constructor(workspace, maxSh, filter) {
    this.workspace = workspace;
    this.maxSh = maxSh;
    this.inputSh = 0;
    this.length = 0;
    this.invalid = 0;
    this.cropped = 0;
    // What retain() checks: the Pool and crop, the fields that every splat
    // needs and how far each has arrived, the splats checked, and the first
    // `kept` of them, which stay.
    this.filter = filter;
    this.pool = undefined;
    this.withinDist = filter.withinDist;
    this.fields = [];
    this.received = {};
    this.checked = 0;
    this.kept = 0;
    this.columns = undefined;
    this.record = new Float64Array(16);
    this.rows = SH_DIMS.map((dims) => new Uint16Array(dims));
    this.records = new PagedArray(workspace, Float32Array);
    this.sh = SH_DIMS.map(() => new PagedArray(workspace, Uint16Array));
    // The two children of the i-th merged splat are entries 2i and 2i + 1 of
    // `children`. Once buildLod() has laid out the tree, a splat's children
    // are the childCount consecutive rows from row childStart.
    this.childStart = new PagedArray(workspace, Float64Array);
    this.childCount = new IndexArray(workspace);
    this.children = new IndexArray(workspace);
    // Area × opacity for merging and, after selection clears the column,
    // for SH clustering in chunk order.
    this.weight = new PagedArray(workspace, Float64Array);
    // Each splat's feature size, for the passes that read nothing else of a
    // record, and the bounds of the centers; see reorder().
    this.sizes = new PagedArray(workspace, Float32Array);
    this.bounds = undefined;
    // Child weights for SH blending and SOG Blind inheritance.
    this.blend = undefined;
    // Each splat's shape while buildLod() builds the tree; see shape().
    this.shapes = undefined;
    // Sorted leaf -> decoded SH row. mergeSh() reuses it for merge-read order.
    this.shOrder = undefined;
    this.merged = new Float64Array(16);
    this.merger = new Merger();
  }

  receive(name, base, values) {
    if (name === "ply") return;
    if (name === "init") {
      if (base > 0xffffffff) throw new Error("Input exceeds u32 index limit");
      this.length = base;
      this.records.length = base * 16;
      this.inputSh = values[0];
      this.maxSh = Math.min(this.maxSh, this.inputSh, 3);
      for (let band = 0; band < this.maxSh; band++)
        this.sh[band].length = base * SH_DIMS[band];
      this.pool = this.filter.start(base);
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
    this.arrived(
      name === "lnScale" ? "scale" : name,
      base + values.length / dims,
    );
  }

  read(index, output) {
    return this.records.read(index * 16, output, 16);
  }

  // Skips empty splats and counts invalid ones in `invalid`: NaN or infinite
  // values, including a zero rotation, which the decoder normalizes to NaN.
  // Optionally keeps only centers within [x, y, z, radius], counting the
  // otherwise usable splats outside this sphere in `cropped`. Most splats
  // are checked as their fields arrive, see arrived(); this checks the rest.
  retain() {
    const { length, pool } = this;
    const from = this.checked;
    const progress = new Progress("Filtering splats", length - from);
    const block = pool.results.length;
    while (this.checked < length) {
      this.check(Math.min(block, length - this.checked));
      progress.update(this.checked - from);
    }
    const count = this.kept;
    this.length = count;
    this.records.length = count * 16;
    for (let band = 0; band < this.maxSh; band++)
      this.sh[band].length = count * SH_DIMS[band];
    progress.finish(`${count} usable splats`);
  }

  // Notes that the splats before `end` have `field`, and checks those that
  // have every field, a block at a time while their pages are cached.
  arrived(field, end) {
    this.received[field] = Math.max(this.received[field] ?? 0, end);
    let complete = this.length;
    for (const key of this.fields)
      complete = Math.min(complete, this.received[key] ?? 0);
    const block = this.pool.results.length;
    while (complete - this.checked >= block) this.check(block);
  }

  // Workers refresh, check and crop the next `size` splats; this thread
  // checks those they leave, and moves kept splats after the splats kept so
  // far.
  check(size) {
    const { pool, withinDist, record, rows } = this;
    const { results } = pool;
    this.columns ??= [
      [this.records.share(), 16],
      ...this.sh
        .slice(0, this.maxSh)
        .map((column, band) => [column.share(), SH_DIMS[band]]),
    ];
    const base = this.checked;
    for (const [column, stride] of this.columns)
      column.load(
        base * stride,
        (base + size) * stride,
        column === this.records,
      );
    pool.check(this, base, size, withinDist);
    let count = this.kept;
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
      // The record's page is cached.
      this.sizes.set(count, this.records.get(count * 16 + 14));
      count++;
    }
    this.kept = count;
    this.checked += size;
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

  // RAD chunk ordering uses packed shapes for sorted leaves and merged nodes.
  prepareShapes() {
    this.shapes = new PagedArray(this.workspace, Uint32Array);
    this.shapeCount = 0;
    this.shapeRows = new Uint32Array(SHAPE_BLOCK * SHAPE_WORDS);
    this.shapeFloats = new Float32Array(this.shapeRows.buffer);
    this.shapeFields = new Float32Array(SHAPE_BLOCK * 7);
    this.shapeBits = new Uint16Array(SHAPE_BLOCK * 7);
  }

  shape(record) {
    if (this.shapeCount === SHAPE_BLOCK) this.writeShapes();
    const i = this.shapeCount++;
    for (let d = 0; d < 3; d++)
      this.shapeFloats[i * SHAPE_WORDS + d] = record[d];
    for (let d = 0; d < 7; d++) this.shapeFields[i * 7 + d] = record[7 + d];
  }

  // Writes the shapes that shape() noted.
  writeShapes() {
    const count = this.shapeCount;
    if (!count) return;
    const bits = halfArray(this.shapeFields, this.shapeBits, count * 7);
    const rows = this.shapeRows;
    for (let i = 0; i < count; i++) {
      const row = i * SHAPE_WORDS;
      const at = i * 7;
      rows[row + 3] = bits[at] | (bits[at + 1] << 16);
      rows[row + 4] = bits[at + 2] | (bits[at + 3] << 16);
      rows[row + 5] = bits[at + 4] | (bits[at + 5] << 16);
      rows[row + 6] = bits[at + 6];
    }
    this.shapes.write(this.shapes.length, rows, count * SHAPE_WORDS);
    this.shapeCount = 0;
  }

  // Adds the merge `out` of splats `a` and `b`, blended with weights w and v.
  append(a, b, out, w, v) {
    const index = this.length++;
    this.records.write(index * 16, out);
    if (this.shapes) {
      this.shape(out);
      this.weight.set(index, out[15] * out[3]);
    }
    this.sizes.set(index, out[14]);
    this.children.push(a);
    this.children.push(b);
    // SH coefficients do not affect merging; mergeSh() blends them later.
    if (this.blend) {
      this.blend.push(w);
      this.blend.push(v);
    }
    return index;
  }

  // Blend one band at a time, gathering its retained rows into chunk order
  // before the next band needs space for intermediate parents.
  mergeSh(indices, pool) {
    this.workspace.rest([]);
    const initial = this.shOrder.length;
    // Each leaf occurs once, as a merge child or the lone root. Replace its
    // decoded SH row with its position in merge-read order.
    const reads = new IndexArray(this.workspace);
    const collecting = new Progress(
      "Collecting SH order",
      this.length - initial,
    );
    for (let k = 0; k < (this.length - initial) * 2; k++) {
      const child = this.children.get(k);
      if (child < initial) {
        reads.push(this.shOrder.get(child));
        this.shOrder.set(child, reads.length - 1);
      }
      if ((k & 4095) === 0) collecting.update(k / 2);
    }
    if (this.length === initial) {
      reads.push(this.shOrder.get(0));
      this.shOrder.set(0, 0);
    }
    collecting.finish();
    const leafRows = new Permutation(
      this.workspace,
      reads.consumingRange(),
      initial,
      "Preparing SH order",
    );
    reads.dispose();

    // Only leaf rows change in merge-read order. Parent rows keep their tree indices.
    const order = new Progress("Collecting LOD SH order", indices.length);
    for (let i = 0; i < indices.length; i++) {
      const node = indices.get(i);
      if (node < initial) indices.set(i, this.shOrder.get(node));
      if ((i & 4095) === 0) order.update(i);
    }
    order.finish();
    this.shOrder.dispose();
    const chunkRows = new Permutation(
      this.workspace,
      indices.consumingRange(),
      this.length,
      "Preparing LOD SH order",
    );
    indices.dispose();

    for (let band = 0; band < this.maxSh; band++) {
      const dims = SH_DIMS[band];
      const column = leafRows.apply(this.sh[band], dims, pool, {
        label: `Reordering SH${band + 1}`,
      });
      const last = band + 1 === this.maxSh;
      if (last) leafRows.dispose();
      this.blendSh(column, band, initial, pool);
      if (last) {
        this.children.dispose();
        this.blend.dispose();
      }
      this.sh[band] = chunkRows.apply(column, dims, pool, {
        label: `Reordering LOD SH${band + 1}`,
      });
    }
    chunkRows.dispose();
  }

  // Workers blend earlier children. The main thread resolves dependencies
  // within a batch in creation order, rounding each parent to FP16.
  blendSh(column, band, initial, pool) {
    const { nodes, entries, later, blends } = pool;
    const dims = SH_DIMS[band];
    const size = later.length;
    const rows = [new Uint16Array(dims), new Uint16Array(dims)];
    const progress = new Progress(
      `Blending SH${band + 1}`,
      this.length - initial,
    );
    // The batch that last counted each page of the column.
    const counted = new Float64Array(
      Math.ceil((this.length * dims) / column.items),
    );
    let batch = 0;
    // The row of the next decoded splat that a merge reads.
    let next = 0;
    for (let start = initial; start < this.length; ) {
      const limit = Math.min(size, this.length - start);
      const pages = Math.max(
        1,
        Math.floor(this.workspace.capacity / PAGE_BYTES / 2),
      );
      batch++;
      let taken = 0;
      let count = 0;
      // Load the pages of the children's rows for the workers. Consecutive
      // splats' children often share pages; a page evicted meanwhile is a
      // miss that the main thread blends.
      let left = -1;
      let right = -1;
      while (count < limit) {
        const k = (start + count - initial) * 2;
        const a = this.children.get(k);
        const b = this.children.get(k + 1);
        const ra = a < initial ? next : a;
        const rb = b < initial ? next + Number(a < initial) : b;
        const pa = Math.floor((ra * dims) / column.items);
        const pb = Math.floor((rb * dims) / column.items);
        let added = Number(ra < start && counted[pa] !== batch);
        if (rb < start && counted[pb] !== batch && !(added && pb === pa))
          added++;
        if (count && taken + added > pages) break;
        taken += added;
        if (ra < start) counted[pa] = batch;
        if (rb < start) counted[pb] = batch;
        next += Number(a < initial) + Number(b < initial);
        const i = count++;
        nodes[i] = ra;
        entries[i] = rb;
        blends[i * 2] = this.blend.get(k);
        blends[i * 2 + 1] = this.blend.get(k + 1);
        later[i] = Number(ra >= start || rb >= start);
        if (later[i]) continue;
        if (pa !== left) {
          left = pa;
          column.page(ra * dims);
        }
        if (pb !== right) {
          right = pb;
          column.page(rb * dims);
        }
      }
      pool.blend(column, start, count, dims, rows);
      start += count;
      progress.update(start - initial);
    }
    progress.finish();
  }

  // Moves record indices[i] to row i. The caller owns the index array.
  // The splats' sizes, weights and shapes, and the bounds of their centers,
  // come from the records while each window of them is cached.
  reorder(indices, pool) {
    const permutation = new Permutation(
      this.workspace,
      indices,
      this.length,
      "Preparing splat order",
    );
    this.sizes.dispose();
    const sizes = this.sizes;
    const bounds = {
      min: [0, 1, 2].map(() => Number.POSITIVE_INFINITY),
      max: [0, 1, 2].map(() => Number.NEGATIVE_INFINITY),
    };
    const record = new Float64Array(16);
    this.records = permutation.apply(this.records, 16, pool, {
      label: "Reordering splats",
      visit: (records, start, end) => {
        for (let i = start; i < end; i++) {
          records.read(i * 16, record, 16);
          for (let d = 0; d < 3; d++) {
            bounds.min[d] = Math.min(bounds.min[d], record[d]);
            bounds.max[d] = Math.max(bounds.max[d], record[d]);
          }
          sizes.set(i, record[14]);
          if (this.shapes) {
            this.weight.set(i, record[15] * record[3]);
            this.shape(record);
          }
        }
      },
    });
    this.bounds = bounds;
    permutation.dispose();
  }

  dispose() {
    for (const column of [
      this.records,
      ...this.sh,
      this.childStart,
      this.childCount,
      this.children,
      this.weight,
      this.sizes,
    ])
      column.dispose();
    this.blend?.dispose();
    this.shapes?.dispose();
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
    const total = wa + wb;
    // Single-axis splats can pass filtering with zero area.
    const w = total === 0 ? 0.5 : wa / total;
    const v = total === 0 ? 0.5 : wb / total;
    this.w = w;
    this.v = v;
    for (let d = 0; d < 3; d++) {
      out[d] = Math.fround(ca[d] * w + cb[d] * v);
      out[4 + d] = half(ca[3 + d] * w + cb[3 + d] * v);
    }
    // The between-center covariance is w * v * delta * deltaᵀ.
    const dx = ca[0] - cb[0];
    const dy = ca[1] - cb[1];
    const dz = ca[2] - cb[2];
    const cross = w * v;
    const wx = cross * dx;
    const wy = cross * dy;
    const wz = cross * dz;
    const cov = this.cov;
    cov[0] = ca[6] * w + cb[6] * v + wx * dx;
    cov[1] = ca[7] * w + cb[7] * v + wy * dy;
    cov[2] = ca[8] * w + cb[8] * v + wz * dz;
    cov[3] = ca[9] * w + cb[9] * v + wx * dy;
    cov[4] = ca[10] * w + cb[10] * v + wx * dz;
    cov[5] = ca[11] * w + cb[11] * v + wy * dz;
    for (const value of cov)
      if (!Number.isFinite(value)) throw new Error("LOD covariance overflow");
    eigens(cov, this.matrix, this.vectors, this.axes);
    const r = this.rotation;
    const floor = this.matrix[this.axes[0] * 4] * MIN_ASPECT ** 2;
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
        Math.sqrt(Math.max(floor, this.matrix[axis * 3 + axis])),
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
    for (let d = 7; d <= 9; d++) out[d] = half(Math.log(out[d]));
    quaternion(r, out);
    for (let d = 10; d <= 13; d++) out[d] = half(out[d]);
    refresh(out, 0, total);
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
