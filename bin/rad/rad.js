// RAD v1 encoding adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { HALF, half, halfBits, opacityRadius } from "./math.js";
import { WorkerGroup, encoders } from "./parallel.js";
import { Progress } from "./progress.js";
import { SH_DIMS } from "./splats.js";
import { readAll, removePath, writeAll } from "./storage.js";

const CHUNK = 65536;
// Fixed s8 range with SPZ's 1/128 SH step; -1 clips to -127/128.
const SH_MAX = 127 / 128;
function encodeSh(value) {
  const magnitude = Math.min(127, Math.round(Math.abs(value) * 128));
  return (value < 0 ? -magnitude : magnitude) & 255;
}
const SH_CODES = Uint8Array.from(HALF, encodeSh);
function header(magic, meta) {
  const json = Buffer.from(JSON.stringify(meta));
  const result = Buffer.alloc(8 + Math.ceil(json.length / 8) * 8);
  result.write(magic);
  result.writeUInt32LE(json.length, 4);
  json.copy(result, 8);
  return result;
}
function exists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function chunkStem(output) {
  const stem = path.basename(output, path.extname(output));
  // Keep the on-disk name usable as a relative URL and a resolveFile key.
  // Escape '=' too so distinct stems cannot produce the same chunk names.
  return Array.from(stem, (char) =>
    char <= " " || "\\%#?:=".includes(char)
      ? encodeURIComponent(char).replace("%", "=")
      : char,
  ).join("");
}
export function checkOutput(output, chunked) {
  if (path.extname(output).toLowerCase() !== ".rad")
    throw new Error("Output must have a .rad extension");
  if (exists(output)) throw new Error(`Output already exists: ${output}`);
  if (!statSync(path.dirname(output)).isDirectory())
    throw new Error("Output parent is not a directory");
  if (chunked) {
    const prefix = `${chunkStem(output)}-`;
    for (const name of readdirSync(path.dirname(output))) {
      if (
        name.startsWith(prefix) &&
        /^\d+\.radc$/.test(name.slice(prefix.length))
      )
        throw new Error(`Output chunk already exists: ${name}`);
    }
  }
}
class Histogram {
  constructor() {
    this.counts = new Float64Array(65536);
    this.count = 0;
  }
  // Adds the counts of a Histogram, also one copied from a worker.
  merge(other) {
    for (let i = 0; i < 65536; i++) this.counts[i] += other.counts[i];
    this.count += other.count;
  }
  add(bits) {
    this.counts[bits & 32768 ? bits ^ 65535 : bits ^ 32768]++;
    this.count++;
  }
  percentile(fraction) {
    let rank = Math.min(
      this.count - 1,
      Math.round(Math.fround(Math.fround(this.count) * Math.fround(fraction))),
    );
    for (let i = 0; i < 65536; i++) {
      if (rank < this.counts[i]) return HALF[i & 32768 ? i ^ 32768 : i ^ 65535];
      rank -= this.counts[i];
    }
    throw new Error("Empty encoding histogram");
  }
}
function alpha(value) {
  return value > 1
    ? half(Math.min(2, 1 + 0.25 * (opacityRadius(value) - 1)))
    : value;
}
// The base attributes that determine the encoding ranges.
class Counts {
  constructor() {
    this.colors = new Histogram();
    this.scales = new Histogram();
    this.alphaF16 = false;
  }
  add(records) {
    for (let offset = 0; offset < records.length; offset += 16) {
      this.alphaF16 ||= alpha(records[offset + 3]) > 1;
      for (let d = 4; d <= 6; d++)
        this.colors.add(halfBits(records[offset + d]));
      const a = records[offset + 7];
      const b = records[offset + 8];
      const c = records[offset + 9];
      this.scales.add(
        halfBits(Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))),
      );
      this.scales.add(halfBits(Math.max(a, b, c)));
    }
  }
  merge(other) {
    this.colors.merge(other.colors);
    this.scales.merge(other.scales);
    this.alphaF16 ||= other.alphaF16;
  }
}

function encoding(counts) {
  const { colors, scales } = counts;
  const rgbMin = Math.min(0, colors.percentile(0.01));
  const rgbMax = Math.max(1, colors.percentile(0.99));
  const lnScaleMin = Math.min(
    -12,
    Math.max(Math.log(1e-30), scales.percentile(0.01)),
  );
  const lnScaleMax = Math.max(9, scales.percentile(0.99));
  return {
    alphaF16: counts.alphaF16,
    rgbF16: rgbMin < -1 || rgbMax > 2,
    scaleF16: lnScaleMax - lnScaleMin > 25,
    meta: {
      rgbMin,
      rgbMax,
      lnScaleMin,
      lnScaleMax,
      sh1Max: SH_MAX,
      sh2Max: SH_MAX,
      sh3Max: SH_MAX,
      lodOpacity: true,
    },
  };
}
const unorm = (value, min, max) =>
  Math.round(Math.max(0, Math.min(255, ((value - min) / (max - min)) * 255)));

// The columns encodeChunk() reads. With a codebook, labels replace the SH.
function gather(splats, base, count, codebook) {
  return {
    base,
    count,
    maxSh: splats.maxSh,
    records: splats.records.read(base * 16, new Float32Array(count * 16)),
    sh: codebook
      ? []
      : splats.sh
          .slice(0, splats.maxSh)
          .map((column, band) =>
            column.read(
              base * SH_DIMS[band],
              new Uint16Array(count * SH_DIMS[band]),
            ),
          ),
    ...(codebook && {
      labels: codebook.labels.read(base, new Uint16Array(count)),
    }),
    counts: splats.childCount.read(base, new Uint32Array(count)),
    starts: splats.childStart.read(base, new Float64Array(count)),
  };
}

// The codebook's entries as s8 codes of each band, coefficient by coefficient.
function encodeCodes(codebook, maxSh) {
  const { count, dims, codes } = codebook;
  const bands = [];
  let offset = 0;
  for (let band = 0; band < maxSh; band++) {
    const size = SH_DIMS[band];
    const bytes = new Uint8Array(count * size);
    for (let d = 0; d < size; d++)
      for (let c = 0; c < count; c++)
        bytes[d * count + c] = encodeSh(codes[c * dims + offset + d]);
    bands.push(bytes);
    offset += size;
  }
  return bands;
}

// Raw property bytes, reused: each property is compressed before the next.
const scratch = [Buffer.alloc(0), Buffer.alloc(0)];
function raw(size, slot = 0) {
  if (scratch[slot].length < size) scratch[slot] = Buffer.allocUnsafe(size);
  return scratch[slot].subarray(0, size);
}

function encodeChunk(chunk, encoding) {
  const { base, count, records } = chunk;
  const properties = [];
  const payloads = [];
  let payloadBytes = 0;
  // Compresses a property's bytes and appends them, padded to 8 bytes.
  const property = (name, codec, data, range) => {
    const bytes = deflateRawSync(data, { level: 6 });
    const padding = Buffer.alloc((8 - (bytes.length % 8)) % 8);
    properties.push({
      property: name,
      encoding: codec,
      compression: "gz",
      ...(range && { min: range[0], max: range[1] }),
      offset: payloadBytes,
      bytes: bytes.length,
    });
    payloads.push(bytes, padding);
    payloadBytes += bytes.length + padding.length;
  };
  const input = new Uint8Array(records.buffer);
  let bytes = raw(count * 12);
  for (let b = 0; b < 4; b++)
    for (let d = 0; d < 3; d++)
      for (let i = 0; i < count; i++)
        bytes[(b * 3 + d) * count + i] = input[i * 64 + d * 4 + b];
  property("center", "f32_lebytes", bytes);
  bytes = raw(count * (encoding.alphaF16 ? 2 : 1));
  for (let i = 0; i < count; i++) {
    const value = alpha(records[i * 16 + 3]);
    if (encoding.alphaF16) bytes.writeUInt16LE(halfBits(value), i * 2);
    else bytes[i] = unorm(value, 0, 2);
  }
  property(
    "alpha",
    encoding.alphaF16 ? "f16" : "r8",
    bytes,
    encoding.alphaF16 ? undefined : [0, 2],
  );
  bytes = raw(count * 3 * (encoding.rgbF16 ? 2 : 1));
  for (let d = 0; d < 3; d++) {
    let last = 0;
    for (let i = 0; i < count; i++) {
      const value = records[i * 16 + 4 + d];
      const offset = d * count + i;
      if (encoding.rgbF16) bytes.writeUInt16LE(halfBits(value), offset * 2);
      else {
        const code = unorm(value, encoding.meta.rgbMin, encoding.meta.rgbMax);
        bytes[offset] = (code - last) & 255;
        last = code;
      }
    }
  }
  property(
    "rgb",
    encoding.rgbF16 ? "f16" : "r8_delta",
    bytes,
    encoding.rgbF16 ? undefined : [encoding.meta.rgbMin, encoding.meta.rgbMax],
  );
  bytes = raw(count * 3 * (encoding.scaleF16 ? 2 : 1));
  for (let d = 0; d < 3; d++)
    for (let i = 0; i < count; i++) {
      const value = records[i * 16 + 7 + d];
      const offset = d * count + i;
      if (encoding.scaleF16) bytes.writeUInt16LE(halfBits(value), offset * 2);
      else
        bytes[offset] =
          value <= -30
            ? 0
            : 1 +
              Math.round(
                Math.max(
                  0,
                  Math.min(
                    254,
                    ((value - encoding.meta.lnScaleMin) /
                      (encoding.meta.lnScaleMax - encoding.meta.lnScaleMin)) *
                      254,
                  ),
                ),
              );
    }
  property(
    "scales",
    encoding.scaleF16 ? "ln_f16" : "ln_0r8",
    bytes,
    encoding.scaleF16
      ? undefined
      : [encoding.meta.lnScaleMin, encoding.meta.lnScaleMax],
  );
  bytes = raw(count * 3);
  for (let i = 0; i < count; i++) {
    const offset = i * 16;
    const sign = records[offset + 13] < 0 ? -1 : 1;
    const theta =
      2 * Math.acos(Math.max(0, Math.min(1, records[offset + 13] * sign)));
    const s = Math.sin(theta * 0.5);
    let x = Math.abs(s) < 1e-6 ? 1 : (records[offset + 10] * sign) / s;
    let y = Math.abs(s) < 1e-6 ? 0 : (records[offset + 11] * sign) / s;
    const z = Math.abs(s) < 1e-6 ? 0 : (records[offset + 12] * sign) / s;
    const sum = Math.abs(x) + Math.abs(y) + Math.abs(z);
    x /= sum;
    y /= sum;
    if (z < 0) {
      const old = x;
      x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
      y = (1 - Math.abs(old)) * (y >= 0 ? 1 : -1);
    }
    bytes[i * 3] = unorm(x, -1, 1);
    bytes[i * 3 + 1] = unorm(y, -1, 1);
    bytes[i * 3 + 2] = unorm(theta, 0, Math.PI);
  }
  property("orientation", "oct88r8", bytes);
  if (chunk.labels) {
    // The first chunk holds the codebook for all.
    for (let band = 0; chunk.codes && band < chunk.maxSh; band++)
      property(`sh${band + 1}_code`, "s8", chunk.codes[band], [
        -SH_MAX,
        SH_MAX,
      ]);
    bytes = raw(count * 2);
    for (let i = 0; i < count; i++) bytes.writeUInt16LE(chunk.labels[i], i * 2);
    property("sh_label", "u16", bytes);
  }
  for (let band = 0; band < chunk.sh.length; band++) {
    const dims = SH_DIMS[band];
    const values = chunk.sh[band];
    bytes = raw(count * dims);
    for (let d = 0; d < dims; d++)
      for (let i = 0; i < count; i++)
        bytes[d * count + i] = SH_CODES[values[i * dims + d]];
    property(`sh${band + 1}`, "s8", bytes, [-SH_MAX, SH_MAX]);
  }
  const counts = raw(count * 2);
  const starts = raw(count * 4, 1);
  for (let i = 0; i < count; i++) {
    const children = chunk.counts[i];
    counts.writeUInt16LE(children, i * 2);
    starts.writeUInt32LE(children ? chunk.starts[i] : 0, i * 4);
  }
  property("child_count", "u16", counts);
  property("child_start", "u32", starts);
  const meta = header("RADC", {
    version: 1,
    base,
    count,
    maxSh: chunk.maxSh,
    lodTree: true,
    splatEncoding: encoding.meta,
    payloadBytes,
    properties,
  });
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(payloadBytes));
  return Buffer.concat([meta, size, ...payloads]);
}

// Counts and encodes chunks; in workers, each answers in order.
class Coder {
  constructor() {
    this.counts = new Counts();
    this.format = undefined;
  }
  handle({ type, records, chunk, format }) {
    if (type === "count") this.counts.add(records);
    else if (type === "counts") return this.counts;
    else if (type === "format") this.format = format;
    else return encodeChunk(chunk, this.format);
    return true;
  }
}

// Spreads counting and encoding over worker threads.
class Encoder extends WorkerGroup {
  // Encodes `chunks` with workers when there is more than one and the
  // workspace has room for them.
  constructor(workspace, chunks) {
    const count = encoders(workspace, chunks);
    super(
      new URL(import.meta.url),
      count,
      { coder: true },
      count ? undefined : new Coder(),
      "Encoding",
    );
    this.next = 0;
  }
  get size() {
    return this.workers.length;
  }
  // Sends the next job to the next worker.
  send(message, transfer) {
    return this.request(
      this.workers[this.next++ % this.workers.length],
      message,
      transfer,
    );
  }
  count(records) {
    return this.send({ type: "count", records }, [records.buffer]);
  }
  async counts() {
    const counts = new Counts();
    for (const result of await this.broadcast({ type: "counts" }))
      counts.merge(result);
    return counts;
  }
  use(format) {
    return this.broadcast({ type: "format", format });
  }
  async encode(chunk) {
    const bytes = await this.send({ type: "encode", chunk }, [
      chunk.records.buffer,
      ...chunk.sh.map((values) => values.buffer),
      ...(chunk.labels ? [chunk.labels.buffer] : []),
      ...(chunk.codes ?? []).map((values) => values.buffer),
      chunk.counts.buffer,
      chunk.starts.buffer,
    ]);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  }
}

if (!isMainThread && workerData?.coder) {
  const coder = new Coder();
  parentPort.on("message", (message) => {
    const result = coder.handle(message);
    // The chunk's buffers would otherwise pile up to tens of MiB before the
    // collector frees them.
    gc();
    // A chunk with its own memory moves to the main thread without a copy.
    const own =
      result instanceof Uint8Array &&
      result.byteOffset === 0 &&
      result.byteLength === result.buffer.byteLength;
    parentPort.postMessage(result, own ? [result.buffer] : []);
  });
}

// With a codebook from clusterSh(), splats store SH as its labels.
export async function writeRad(splats, output, chunked, lodBase, codebook) {
  const chunks = [];
  const stem = chunkStem(output);
  const spool = chunked ? undefined : splats.workspace.file();
  // Write every file completely before publishing chunks, then the header.
  // Track published names too, so cancellation rolls back this conversion.
  const staged = [];
  const created = [];
  const stage = (file, write) => {
    splats.workspace.check();
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const fd = openSync(temporary, "wx");
    staged.push({ temporary, file });
    try {
      write(fd);
      fsyncSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {}
      throw error;
    }
    closeSync(fd);
  };
  let total = 0;
  let progress;
  const store = (bytes) => {
    if (chunked) {
      const filename = `${stem}-${chunks.length}.radc`;
      stage(path.join(path.dirname(output), filename), (fd) =>
        writeAll(fd, bytes, 0),
      );
      chunks.push({ offset: 0, bytes: bytes.length, filename });
    } else {
      writeAll(spool, bytes, total);
      chunks.push({ offset: total, bytes: bytes.length });
    }
    total += bytes.length;
    progress.update(chunks.length);
  };
  // Gather the next chunks while workers encode earlier ones; store them in
  // order. A chunk's failure is thrown when its turn comes, not as an
  // unhandled rejection while an earlier chunk is awaited.
  const pending = [];
  const encoder = new Encoder(
    splats.workspace,
    Math.ceil(splats.length / CHUNK),
  );
  try {
    // Count the encoding ranges in a first pass.
    const chunkCount = Math.ceil(splats.length / CHUNK);
    progress = new Progress("Analyzing RAD encoding", chunkCount);
    let countedChunks = 0;
    for (let base = 0; base < splats.length; base += CHUNK) {
      splats.workspace.check();
      const count = Math.min(CHUNK, splats.length - base);
      const records = splats.records.read(
        base * 16,
        new Float32Array(count * 16),
      );
      const counted = encoder
        .count(records)
        .then(() => progress.update(++countedChunks));
      counted.catch(() => {});
      pending.push(counted);
      if (pending.length > encoder.size + 1) await pending.shift();
    }
    while (pending.length) await pending.shift();
    const format = encoding(await encoder.counts());
    await encoder.use(format);
    progress.finish();
    progress = new Progress("Encoding RAD chunks", chunkCount);
    for (let base = 0; base < splats.length; base += CHUNK) {
      splats.workspace.check();
      const chunk = gather(
        splats,
        base,
        Math.min(CHUNK, splats.length - base),
        codebook,
      );
      if (codebook && base === 0)
        chunk.codes = encodeCodes(codebook, splats.maxSh);
      const bytes = encoder.encode(chunk);
      bytes.catch(() => {});
      pending.push(bytes);
      if (pending.length > encoder.size + 1) store(await pending.shift());
    }
    while (pending.length) store(await pending.shift());
    progress.finish(`${chunks.length} chunks`);
    const meta = header("RAD0", {
      version: 1,
      type: "gsplat",
      count: splats.length,
      maxSh: splats.maxSh,
      lodTree: true,
      chunkSize: CHUNK,
      allChunkBytes: total,
      chunks,
      splatEncoding: format.meta,
      ...(codebook && { shCodeCount: codebook.count }),
      comment: `Gaussian Splat Lite quality LOD (base ${lodBase})`,
    });
    const writing = new Progress(
      "Writing RAD file",
      meta.length + (spool === undefined ? 0 : total),
    );
    stage(output, (fd) => {
      writeAll(fd, meta, 0);
      if (spool !== undefined) {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (let offset = 0; offset < total; offset += buffer.length) {
          splats.workspace.check();
          const bytes = buffer.subarray(
            0,
            Math.min(buffer.length, total - offset),
          );
          readAll(spool, bytes, offset);
          writeAll(fd, bytes, meta.length + offset);
          writing.update(meta.length + offset + bytes.length);
        }
      }
    });
    writing.finish();
    const publishing = new Progress("Publishing RAD files", staged.length);
    for (const { temporary, file } of staged) {
      splats.workspace.check();
      // rename can replace an existing file, so reserve the name exclusively.
      const fd = openSync(file, "wx");
      created.push(file);
      closeSync(fd);
      renameSync(temporary, file);
      publishing.update(created.length);
    }
    splats.workspace.check();
    publishing.finish();
    return meta.length + total;
  } catch (error) {
    await Promise.allSettled(pending);
    for (const { temporary } of staged) removePath(temporary);
    for (const file of created) removePath(file);
    throw error;
  } finally {
    await encoder.close();
  }
}
