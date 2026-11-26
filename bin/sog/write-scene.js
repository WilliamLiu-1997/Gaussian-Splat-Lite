import {
  constants,
  accessSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  statSync,
} from "#gsl/files";
import { Buffer } from "#gsl/host";
import { chunkDirectory, openOutput, publishManifest } from "#gsl/output";
import { basename, dirname, join } from "#gsl/path";
import { GENERATOR } from "../generator.js";
import { initialize } from "../rad/input.js";
import { WorkerGroup, clusterers } from "../rad/parallel.js";
import { Progress } from "../rad/progress.js";
import { removePath, sharedBuffer } from "../rad/storage.js";
import { orderChunks } from "./chunk-order.js";
import { planChunks } from "./chunk-plan.js";
import { encodeChunk } from "./encode.js";
import { finishTree } from "./regions.js";
import { SH_DIMS } from "./splats.js";
import { releaseWebp } from "./webp.js";
import { writeChunk } from "./write-chunk.js";
import { writeFile } from "./write-file.js";

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
  const created = [];
  const filenames = [];
  const counts = rows.levels.map((level) => level.length);
  let written = 0;
  let bytes = 0;
  let clipped = 0;
  // Threads each encode a chunk and cluster its SH, as many at once as
  // there is room for; without any, this thread does. A chunk in work takes
  // its gathered splats, its encoding, its SH clustering and its files.
  let encoder;

  function closeEncoder() {
    if (!encoder) return;
    const group = encoder;
    encoder = undefined;
    if (group.workers.length) return group.close();
    releaseWebp();
  }

  try {
    await initialize();
    await orderChunks(rows, regions.order);
    regions.order.dispose();
    const progress = new Progress(
      "Writing SOG chunks",
      rows.length,
      "preparing encoders",
    );
    workspace.settle();
    const dims = SH_DIMS.slice(0, input.maxSh).reduce(
      (sum, width) => sum + width,
      0,
    );
    const plan = planChunks(
      regions.leavesByLevel,
      options,
      dims,
      blindCount,
      kernel,
      workspace.room,
    );
    const total = plan.ends.length;
    let threads = 0;
    if (total > 1)
      threads = clusterers(workspace, plan.bytes, 0, total, plan.bytes);
    else workspace.expect(plan.bytes);
    encoder = new WorkerGroup(
      threads,
      { encoder: true, kernel, cancelled: workspace.cancelled },
      { handle: (job) => encodeChunk(job, kernel, () => workspace.check()) },
      "SOG encoding",
    );
    // Idle threads keep their chunk buffers for reuse.
    const idle = encoder.threads.map((worker) => ({
      worker,
      buffer: sharedBuffer(plan.gathered),
    }));
    const active = new Set();

    let rangeCount = 0;
    for (const [level, leaves] of regions.leavesByLevel.entries()) {
      rangeCount += leaves.length;
      const source = rows.levels[level];
      let first = 0;
      for (let start = 0, end; start < leaves.length; start = end) {
        const file = filenames.length;
        end = plan.ends[file];
        const leafCount = end - start;
        const name = `lod-${level}-${file}`;
        const path = join(staging, name);
        mkdirSync(path);
        while (!idle.length) await Promise.race(active);
        const thread = idle.pop();
        const ranges = new Uint32Array(leafCount * 2);
        let count = 0;
        for (let i = 0; i < leafCount; i++) {
          const { lods } = leaves[start + i];
          const regionCount = lods[level];
          lods[level] = { file, offset: count, count: regionCount };
          ranges[i * 2] = count;
          ranges[i * 2 + 1] = regionCount;
          count += regionCount;
        }
        const chunkDetail = `LOD ${level}/${rows.levels.length - 1}, chunk ${file}/${total - 1}, ${count} splats`;
        progress.update(written, chunkDetail);
        // The chunk's rows are read before the call returns.
        const chunk = writeChunk(
          source,
          first,
          count,
          ranges,
          await chunkDirectory(path, name),
          options,
          encoder,
          thread.worker,
          thread.buffer,
          input,
        ).then((result) => {
          bytes += result.bytes;
          clipped += result.clipped;
          // A region's box holds its splats of every chunk.
          for (let i = 0; i < leafCount; i++) {
            const { bound } = leaves[start + i];
            for (let d = 0; d < 3; d++) {
              bound.min[d] = Math.min(bound.min[d], result.boxes[i * 6 + d]);
              bound.max[d] = Math.max(
                bound.max[d],
                result.boxes[i * 6 + 3 + d],
              );
            }
          }
          written += count;
          progress.update(written, chunkDetail);
          idle.push(thread);
          active.delete(chunk);
        });
        // A failure shows to what waits for the chunk.
        chunk.catch(() => {});
        active.add(chunk);
        if (!threads) await chunk;
        filenames.push(`chunks/${name}/meta.json`);
        first += count;
      }
      regions.leavesByLevel[level] = undefined;
      // Encoders own their gathered buffers.
      source.dispose();
    }
    await Promise.all(active);
    // The manifest may take the threads' memory and their chunks'.
    await closeEncoder();
    idle.length = 0;
    workspace.settle();
    workspace.expect(
      regions.leafCount * 1536 + rangeCount * 256 + filenames.length * 512,
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
    bytes += await writeFile(openOutput(path, output, workspace), (write) =>
      write(Buffer.from(JSON.stringify(manifest))),
    );
    workspace.check();
    mkdirSync(chunks);
    created.push(chunks);
    for (const name of readdirSync(staging)) {
      workspace.check();
      if (name !== "lod-meta.json")
        renameSync(join(staging, name), join(chunks, name));
    }
    // Publish the manifest last, refusing an existing file on every filesystem.
    workspace.check();
    publishManifest(path, output);
    created.push(output);
    workspace.check();
    created.length = 0;
    progress.finish(
      `${filenames.length} files, ${(bytes / 1048576).toFixed(2)} MiB`,
    );
    if (clipped)
      console.warn(
        `SOG v3 clamped mass above 1.5625 and compensated scale for ${clipped} splats (across all LODs)`,
      );
    return { bytes, clipped, counts, files: filenames.length };
  } finally {
    try {
      await closeEncoder();
    } finally {
      for (const path of created.reverse())
        removePath(path, { recursive: path === chunks, force: true });
      removePath(staging, { recursive: true, force: true });
    }
  }
}
