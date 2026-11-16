import {
  constants,
  accessSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { GENERATOR } from "../generator.js";
import { clusterBytes } from "../rad/cluster.js";
import { initialize } from "../rad/input.js";
import { WorkerGroup, clusterers } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import { GIB, removePath } from "../rad/storage.js";
import { entries } from "./cluster.js";
import { MAX_CHUNK_SPLATS, encodeBytes, encodeChunk } from "./encode.js";
import { chunkBuffer, chunkRowBytes } from "./gather.js";
import { finishTree } from "./regions.js";
import { SH_DIMS } from "./splats.js";
import { writeChunk, writeFile } from "./write-chunk.js";

export function checkOutput(output) {
  if (basename(output) !== "lod-meta.json")
    throw new Error("Output must end in lod-meta.json");
  let parent = dirname(output);
  let stats = statSync(parent, { throwIfNoEntry: false });
  while (!stats) {
    parent = dirname(parent);
    stats = statSync(parent, { throwIfNoEntry: false });
  }
  if (!stats.isDirectory())
    throw new Error(`Output parent is not a directory: ${parent}`);
  accessSync(parent, constants.W_OK | constants.X_OK);
  for (const path of [output, join(dirname(output), "chunks")])
    if (lstatSync(path, { throwIfNoEntry: false }))
      throw new Error(`Output already exists: ${path}`);
}

export async function writeScene(rows, regions, output, options, kernel) {
  checkOutput(output);
  const { workspace } = rows;
  const input = rows.levels[0];
  const { blind } = input;
  const blindCount = blind?.textures.length ?? 0;
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, ".gsl-build-sog-"));
  const chunks = join(directory, "chunks");
  let ownsChunks = false;
  let published = false;
  const filenames = [];
  const counts = rows.levels.map((level) => level.length);
  const progress = new Progress("Writing SOG chunks", rows.length);
  let chunkDetail = "";
  let written = 0;
  let bytes = 0;
  let clipped = 0;
  // Threads each encode a chunk and cluster its SH, as many at once as
  // there is room for; without any, this thread does. A chunk in work takes
  // its gathered splats, its encoding, its SH clustering and its files.
  let encoder;
  try {
    await initialize();
    workspace.settle();
    const dims = SH_DIMS.slice(0, rows.levels[0].maxSh).reduce(
      (a, b) => a + b,
      0,
    );
    // Both the gathered rows and the WebP encoder must fit their own memory.
    const capacity = Math.min(
      Math.floor((workspace.room * 0.3) / (160 + dims * 8 + blindCount * 4)),
      Math.floor((4 * GIB) / chunkRowBytes(dims, blindCount)),
      MAX_CHUNK_SPLATS,
    );
    const limit = Math.min(options.lodChunkCount, capacity);
    if (limit < 1) throw new Error("Memory budget too small for SOG encoding");
    // The chunks that the levels' regions fill, as the loop below fills them.
    let total = 0;
    let largest = 0;
    for (let level = 0; level < rows.levels.length; level++) {
      let size = 0;
      for (const leaf of regions.leaves) {
        const count = leaf.lods[level]?.count ?? 0;
        if (count > limit) {
          const increase =
            count <= capacity ? " or increase --lod-chunk-count" : "";
          throw new Error(
            `A region has ${count} splats, more than the chunk limit of ${limit}; reduce --region-splats${increase}`,
          );
        }
        if (size && size + count > limit) {
          total++;
          largest = Math.max(largest, size);
          size = 0;
        }
        size += count;
      }
      if (size) {
        total++;
        largest = Math.max(largest, size);
      }
    }
    // An entry per splat needs float codes and labels, but no clustering.
    const codes = dims ? entries(largest, options) : 0;
    const chunkBytes =
      largest * (124 + dims * 2 + blindCount * 4) +
      encodeBytes(largest, dims, codes, blindCount) +
      (!dims
        ? 0
        : codes < largest
          ? clusterBytes(kernel, largest, dims, codes)
          : largest * (4 + dims * 4));
    const threads = clusterers(workspace, chunkBytes, 0, total);
    if (!threads) workspace.expect(chunkBytes);
    encoder = new WorkerGroup(
      new URL("./encode.js", import.meta.url),
      threads,
      { encoder: true, kernel, cancelled: workspace.cancelled },
      { handle: (job) => encodeChunk(job, kernel, () => workspace.check()) },
      "SOG encoding",
    );
    // Idle threads keep their chunk buffers for reuse.
    const idle = encoder.threads.map((worker) => ({
      worker,
      buffer: chunkBuffer(largest, dims, blindCount),
    }));
    const active = new Set();

    // The rows of the chunk that is being filled, kept from chunk to chunk:
    // as garbage, each chunk's would take room from the cache.
    const order = new Uint32Array(largest);
    for (let level = 0; level < rows.levels.length; level++) {
      const source = rows.levels[level];
      // The chunk's splats so far, and the regions that they belong to with
      // each one's first splat and count in the chunk.
      let size = 0;
      let leaves = [];
      let ranges = [];
      const flush = async () => {
        if (!size) return;
        const count = size;
        const measured = leaves;
        const name = `lod-${level}-${filenames.length}`;
        const path = join(staging, name);
        mkdirSync(path);
        while (!idle.length) await Promise.race(active);
        const thread = idle.pop();
        chunkDetail = `LOD ${level}/${rows.levels.length - 1}, chunk ${filenames.length}/${total - 1}, ${count} splats`;
        progress.update(written, chunkDetail);
        // The chunk's rows are read before the call returns.
        const chunk = writeChunk(
          source,
          order.subarray(0, count),
          Uint32Array.from(ranges),
          path,
          options,
          encoder,
          thread.worker,
          thread.buffer,
          input,
        ).then((result) => {
          bytes += result.bytes;
          clipped += result.clipped;
          // A region's box holds its splats of every chunk.
          measured.forEach(({ bound }, i) => {
            for (let d = 0; d < 3; d++) {
              bound.min[d] = Math.min(bound.min[d], result.boxes[i * 6 + d]);
              bound.max[d] = Math.max(
                bound.max[d],
                result.boxes[i * 6 + 3 + d],
              );
            }
          });
          written += count;
          progress.update(written, chunkDetail);
          idle.push(thread);
          active.delete(chunk);
        });
        // A failure shows to what waits for the chunk.
        chunk.catch(() => {});
        active.add(chunk);
        filenames.push(`chunks/${name}/meta.json`);
        size = 0;
        leaves = [];
        ranges = [];
      };
      for (const leaf of regions.leaves) {
        const range = leaf.lods[level];
        if (!range) continue;
        if (size + range.count > limit) await flush();
        // In the order of the chunk; see buildRegions().
        regions.order.read(range.start, order, range.count, size);
        leaf.lods[level] = {
          file: filenames.length,
          offset: size,
          count: range.count,
        };
        leaves.push(leaf);
        ranges.push(size, range.count);
        size += range.count;
      }
      await flush();
      // Encoders own gathered buffers; later LODs only need the Blind table.
      source.records.dispose();
      for (const band of source.sh) band.dispose();
    }
    await Promise.all(active);
    // The manifest may take the threads' memory and their chunks'.
    await encoder.close();
    idle.length = 0;
    workspace.settle();
    workspace.expect(
      regions.leaves.length * (1536 + counts.length * 256) +
        filenames.length * 512,
    );
    const manifest = {
      version: 1,
      asset: { generator: GENERATOR },
      count: rows.length,
      counts,
      lodLevels: counts.length,
      filenames,
      tree: finishTree(regions.root),
      model: input.model,
      ...(input.comments?.length ? { comments: input.comments } : {}),
    };
    const path = join(staging, "lod-meta.json");
    bytes += writeFile(workspace, path, Buffer.from(JSON.stringify(manifest)));
    workspace.check();
    mkdirSync(chunks);
    ownsChunks = true;
    for (const name of readdirSync(staging))
      if (name !== "lod-meta.json")
        renameSync(join(staging, name), join(chunks, name));
    // Publish the manifest last, refusing an existing file on every filesystem.
    copyFileSync(path, output, constants.COPYFILE_EXCL);
    published = true;
    progress.finish(
      `${filenames.length} files, ${(bytes / 1048576).toFixed(2)} MiB`,
    );
    if (clipped)
      console.warn(
        `SOG v3 clamped mass above 1.5625 and compensated scale for ${clipped} splats (across all LODs)`,
      );
    return { bytes, clipped, counts, files: filenames.length };
  } finally {
    await encoder?.close();
    if (!published && ownsChunks)
      removePath(chunks, { recursive: true, force: true });
    removePath(staging, { recursive: true, force: true });
  }
}
