import { closeSync, fdatasyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { encodeWebp, sogBounds } from "../decoder/decoder.js";
import { initialize } from "../rad/input.js";
import { collect } from "../rad/storage.js";
import { cluster } from "./cluster.js";
import { QUANTIZE_BYTES, encodeRotation, label, quantize } from "./quantize.js";
import { SH_C0 } from "./splats.js";

const logPosition = (v) => Math.sign(v) * Math.log1p(Math.abs(v));

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

// Encodes the centers, rotations, scales, colors and opacities of a chunk's
// `count` splats in `records`, and hands each image to `write` as its file
// name and bytes. Returns what meta.json says of them, how many splats have
// more mass than SOG holds, and the boxes of the `ranges` of splats, pairs
// of first splat and count, six values each: what the splats of a range
// reach at three standard deviations as a reader decodes them, see
// sogBounds().
function encodeGeometry({ records, count, ranges }, write) {
  const rotation = new Uint8Array(count * 3);
  const { width, height } = imageSize(count);
  const image = new Uint8Array(width * height * 4);
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
    if (record[3] > 1.5625) clipped++;
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
    image.fill(0);
    for (let i = 0; i < count; i++) {
      for (let d = 0; d < 3; d++)
        image[i * 4 + d] = (positions[i * 3 + d] >>> (part * 8)) & 255;
      image[i * 4 + 3] = rotation[i * 3 + part];
    }
    write(
      part ? "means_u.webp" : "means_l.webp",
      encodeWebp(image, width, height),
    );
  }
  for (let i = 0; i < count; i++)
    for (let d = 0; d < 3; d++) values[i * 3 + d] = records[i * 16 + 7 + d];
  const scales = quantize(values, 0.25);
  const scaleLabels = new Uint8Array(count * 3);
  image.fill(0);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) {
      scaleLabels[i * 3 + d] = label(values[i * 3 + d], scales);
      image[i * 4 + d] = scaleLabels[i * 3 + d];
    }
    image[i * 4 + 3] = rotation[i * 3 + 2];
  }
  write("scales.webp", encodeWebp(image, width, height));
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
  image.fill(0);
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
  write("sh0.webp", encodeWebp(image, width, height));
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
// the label of each of its `count` splats, and hands each image to `write`
// as its file name and bytes. Returns the scalar codebook of the codes.
function encodeSh({ codes, labels, dims, entries, count }, write) {
  const scalar = quantize(codes);
  const coefficients = dims / 3;
  const { width: paletteWidth, height: paletteHeight } = paletteSize(
    entries,
    dims,
  );
  const palette = new Uint8Array(paletteWidth * paletteHeight * 4);
  for (let entry = 0; entry < entries; entry++)
    for (let c = 0; c < coefficients; c++) {
      const pixel = (entry * coefficients + c) * 4;
      for (let d = 0; d < 3; d++)
        palette[pixel + d] = label(codes[entry * dims + c * 3 + d], scalar);
      palette[pixel + 3] = 255;
    }
  write("shN_centroids.webp", encodeWebp(palette, paletteWidth, paletteHeight));
  const { width, height } = imageSize(count);
  const image = new Uint8Array(width * height * 4);
  for (let i = 0; i < count; i++) {
    const value = labels[i];
    image[i * 4] = value & 255;
    image[i * 4 + 1] = (value >>> 8) & 255;
    image[i * 4 + 2] = (value >>> 16) & 255;
    image[i * 4 + 3] = 255;
  }
  write("shN_labels.webp", encodeWebp(image, width, height));
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
  const { records, sh, weights, dims, count, options, directory, maxSh } = job;
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
  const { means, scales, sh0, opacityMax, clipped, boxes } = encodeGeometry(
    { records, count, ranges: job.ranges },
    write,
  );
  const meta = {
    version: 3,
    asset: { generator: "Gaussian-Splat-Lite gsl-build-sog" },
    count,
    means: { ...means, files: ["means_l.webp", "means_u.webp"] },
    scales: { codebook: scales, files: ["scales.webp"] },
    sh0: { codebook: sh0, files: ["sh0.webp"] },
  };
  if (opacityMax > 204) meta.opacity = { max: (opacityMax / 204) ** 2 };
  if (dims) {
    const codebook = await cluster(
      { sh, weights, dims },
      options,
      kernel,
      check,
    );
    const { codes, labels, count: entries } = codebook;
    const scalar = encodeSh({ codes, labels, dims, entries, count }, write);
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

// Bytes that encoding a chunk of `count` splats takes besides the job, with
// SH of `dims` coefficients in a codebook of `entries` codes: the images of
// the splats, of which the geometry's and the labels' may both be alive,
// the codebook's image, and an encoded image; the encoder's own memory,
// which grows with the largest image and stays, counted as 8 bytes a byte
// of it (measured with its copy of the image: 6.3 for noise, 2 for smooth
// images); the scalar codebooks' histogram; and 36 bytes a splat of work
// arrays: rotations and values to quantize, center codes and scale labels,
// and the decoder module's copies of the codes for the bounds.
export function encodeBytes(count, dims, entries) {
  const { width, height } = imageSize(count);
  const points = width * height * 4;
  let codebook = 0;
  if (dims) {
    const palette = paletteSize(entries, dims);
    codebook = palette.width * palette.height * 4;
  }
  const largest = Math.max(points, codebook);
  return (
    2 * points + codebook + 9 * largest + QUANTIZE_BYTES + count * (15 + 9 + 12)
  );
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
    // The job's arrays would otherwise stay until the next job's are there.
    collect();
    parentPort.postMessage(result);
  });
}
