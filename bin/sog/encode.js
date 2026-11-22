import { closeSync, fdatasyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { sogBounds } from "../decoder/decoder.js";
import { GENERATOR } from "../generator.js";
import { initialize } from "../rad/input.js";
import { collect } from "../rad/storage.js";
import { cluster } from "./cluster.js";
import { MAX_MASS, compensateScales } from "./opacity.js";
import { QUANTIZE_BYTES, encodeRotation, label, quantize } from "./quantize.js";
import { SH_C0 } from "./splats.js";
import {
  WEBP_MAX_PIXELS,
  encodeWebp,
  initializeWebp,
  webpBytes,
} from "./webp.js";

const logPosition = (v) => Math.sign(v) * Math.log1p(Math.abs(v));

// imageSize() rounds both sides up to multiples of four.
export const MAX_CHUNK_SPLATS =
  (Math.floor(Math.sqrt(WEBP_MAX_PIXELS) / 4) * 4) ** 2;

// The side lengths of an image with a pixel for each of `count` splats.
function imageSize(count) {
  const width = Math.ceil(Math.sqrt(count) / 4) * 4;
  return { width, height: Math.ceil(count / width / 4) * 4 };
}

// The side lengths of the image of an SH codebook of `entries` codes of
// `dims` coefficients: a row of 64 codes, a pixel per three coefficients.
function paletteSize(entries, dims) {
  return { width: 64 * (dims / 3), height: Math.ceil(entries / 64) };
}

function opaqueImage({ width, height }) {
  const image = new Uint8Array(width * height * 4);
  // Padding must also be opaque for WebP to omit the alpha channel.
  for (let i = 3; i < image.length; i += 4) image[i] = 255;
  return image;
}

// Encodes the centers, rotations, scales, colors and opacities of a chunk's
// `count` splats in `records`. Returns their metadata, how many splats have
// more mass than SOG holds, and the boxes of the `ranges` of splats, pairs
// of first splat and count, six values each: what the splats of a range
// reach at three standard deviations as a reader decodes them, see
// sogBounds().
function encodeGeometry({ records, count, ranges }, image, writeImage) {
  const rotation = new Uint8Array(count * 3);
  const values = new Float32Array(count * 3);
  const min = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  let clipped = 0;
  let opacityMax = 0;
  for (let i = 0; i < count; i++) {
    const record = records.subarray(i * 16, i * 16 + 16);
    encodeRotation(record, rotation, i * 3);
    for (let d = 0; d < 3; d++) {
      record[d] = logPosition(record[d]);
      min[d] = Math.min(min[d], record[d]);
      max[d] = Math.max(max[d], record[d]);
    }
    if (record[3] > MAX_MASS) {
      compensateScales(record);
      clipped++;
    }
  }
  // Each center coordinate as 16 bits, in two images of 8.
  const positions = new Uint16Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++)
      positions[i * 3 + d] =
        max[d] === min[d]
          ? 0
          : Math.round(
              (65535 * (records[i * 16 + d] - min[d])) / (max[d] - min[d]),
            );
  for (let part = 0; part < 2; part++) {
    for (let i = 0; i < count; i++)
      for (let d = 0; d < 3; d++)
        image[i * 4 + d] = (positions[i * 3 + d] >>> (part * 8)) & 255;
    writeImage(part ? "means_u.webp" : "means_l.webp", image);
  }
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++) values[i * 3 + d] = records[i * 16 + 7 + d];
  const scales = quantize(values, 0.25);
  const scaleLabels = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++) {
      scaleLabels[i * 3 + d] = label(values[i * 3 + d], scales);
      image[i * 4 + d] = scaleLabels[i * 3 + d];
    }
  writeImage("scales.webp", image);
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++) image[i * 4 + d] = rotation[i * 3 + d];
  writeImage("quats.webp", image);
  // With the reader's own decoding: the boxes hold the three standard
  // deviations of the Gaussians that a reader decodes from these codes.
  const boxes = sogBounds(
    positions,
    Float32Array.from(min),
    Float32Array.from(max),
    scaleLabels,
    scales,
    rotation,
    ranges,
  );
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++)
      values[i * 3 + d] = (records[i * 16 + 4 + d] - 0.5) / SH_C0;
  const colors = quantize(values);
  image.fill(0, count * 4);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++)
      image[i * 4 + d] = label(values[i * 3 + d], colors);
    const alpha = Math.min(
      255,
      Math.round(204 * Math.sqrt(records[i * 16 + 3])),
    );
    image[i * 4 + 3] = alpha;
    opacityMax = Math.max(opacityMax, alpha);
  }
  writeImage("sh0.webp", image);
  return {
    means: { mins: min, maxs: max },
    scales: Array.from(scales),
    sh0: Array.from(colors),
    opacityMax,
    clipped,
    boxes,
  };
}

// Encodes a chunk's SH codebook, `entries` codes of `dims` coefficients, and
// the label of each of its `count` splats. Returns the scalar codebook.
function encodeSh({ codes, labels, dims, entries, count }, image, writeImage) {
  const scalar = quantize(codes);
  const coefficients = dims / 3;
  const size = paletteSize(entries, dims);
  const palette = opaqueImage(size);
  for (let entry = 0; entry < entries; entry++)
    for (let c = 0; c < coefficients; c++) {
      const pixel = (entry * coefficients + c) * 4;
      for (let d = 0; d < 3; d++)
        palette[pixel + d] = label(codes[entry * dims + c * 3 + d], scalar);
    }
  writeImage("shN_centroids.webp", palette, size);
  for (let i = 0; i < count; i++) {
    const value = labels[i];
    image[i * 4] = value & 255;
    image[i * 4 + 1] = (value >>> 8) & 255;
    image[i * 4 + 2] = (value >>> 16) & 255;
    image[i * 4 + 3] = 255;
  }
  writeImage("shN_labels.webp", image);
  return Array.from(scalar);
}

// Encodes a chunk on this thread and writes its files into `directory`:
// its splats, and with SH of `maxSh` bands their codebook, which is
// clustered here with the `kernel` and `options` of the conversion. Each
// file is written and synced as soon as it is encoded, so the thread that
// gathers the chunks waits for none of them, and no more than one encoded
// image is held at a time. Returns the bytes written, how many
// splats have more mass than SOG holds, and the boxes of the job's `ranges`
// of splats; see encodeGeometry(). Needs the encoder of initialize().
export async function encodeChunk(job, kernel, check) {
  await initializeWebp();
  const { sh, weights, dims, count, options, directory, maxSh } = job;
  let bytes = 0;
  const write = (name, data) => {
    check();
    const fd = openSync(join(directory, name), "wx");
    try {
      writeFileSync(fd, data);
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    bytes += data.byteLength;
  };
  const size = imageSize(count);
  const image = opaqueImage(size);
  const writeImage = (name, pixels, { width, height } = size) =>
    encodeWebp(pixels, width, height, (data) => write(name, data));
  const { means, scales, sh0, opacityMax, clipped, boxes } = encodeGeometry(
    job,
    image,
    writeImage,
  );
  const meta = {
    version: 3,
    asset: { generator: GENERATOR },
    count,
    model: job.model,
    means: { ...means, files: ["means_l.webp", "means_u.webp"] },
    scales: { codebook: scales, files: ["scales.webp"] },
    quats: { files: ["quats.webp"] },
    sh0: { codebook: sh0, files: ["sh0.webp"] },
  };
  // sh0 has transparent padding. Blind and label images use opaque black.
  for (let i = count * 4 + 3; i < image.length; i += 4) image[i] = 255;
  if (job.blindTextures?.length) {
    // The converter uses little-endian word storage.
    const pixels = new Uint32Array(image.buffer);
    meta.blind = job.blindTextures.map((fields, texture) => {
      pixels.set(
        job.blindWords.subarray(texture * count, (texture + 1) * count),
      );
      const name = `blind_${texture}.webp`;
      writeImage(name, image);
      return { files: [name], fields };
    });
  }
  if (opacityMax > 204) meta.opacity = { max: (opacityMax / 204) ** 2 };
  if (dims) {
    const codebook = await cluster(
      { sh, weights, dims },
      options,
      kernel,
      check,
    );
    const { codes, labels, count: entries } = codebook;
    const scalar = encodeSh(
      { codes, labels, dims, entries, count },
      image,
      writeImage,
    );
    meta.shN = {
      count: entries,
      bands: maxSh,
      codebook: scalar,
      files: ["shN_centroids.webp", "shN_labels.webp"],
    };
  }
  write("meta.json", Buffer.from(JSON.stringify(meta)));
  return { bytes, clipped, boxes };
}

// WebP keeps its heap and quantize() keeps its histogram between chunks.
export function imageBytes(count, dims, entries) {
  const { width, height } = imageSize(count);
  const points = width * height * 4;
  let codes = 0;
  if (dims) {
    const palette = paletteSize(entries, dims);
    codes = palette.width * palette.height * 4;
  }
  return {
    retained: webpBytes(Math.max(points, codes)) + QUANTIZE_BYTES,
    working: points + codes,
  };
}

if (!isMainThread && workerData?.encoder) {
  const { kernel, cancelled } = workerData;
  const check = () => {
    if (cancelled && Atomics.load(cancelled, 0))
      throw new Error("Conversion cancelled");
  };
  await initialize();
  parentPort.on("message", async (job) => {
    const result = await encodeChunk(job, kernel, check);
    // The chunk's images and codebook would otherwise stay until the next
    // chunk's are there.
    collect();
    parentPort.postMessage(result, [result.boxes.buffer]);
  });
}
