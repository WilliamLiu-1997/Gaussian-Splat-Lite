import { closeSync, fdatasyncSync, openSync } from "node:fs";
import { entries } from "./cluster.js";
import { gather } from "./gather.js";

export function writeFile(workspace, path, data) {
  const fd = openSync(path, "wx");
  try {
    workspace.write(fd, data, 0);
    fdatasyncSync(fd);
  } finally {
    try {
      workspace.writeback.synced(fd);
    } finally {
      closeSync(fd);
    }
  }
  return data.byteLength;
}

// Gathers the chunk of the splats `order` of `source` and has `worker` of
// `encoder`, a thread or this one, encode its images, cluster its SH, write
// its files into `directory` and measure its `ranges`; see encodeChunk().
export async function writeChunk(
  source,
  order,
  ranges,
  directory,
  options,
  encoder,
  worker,
) {
  const { workspace } = source;
  const count = order.length;
  // A thread takes the chunk's arrays. Without one they stay on this thread
  // until collected, and the next chunk's would add to them.
  if (worker) workspace.adjust();
  else workspace.settle();
  const { shCodebook, shIterations } = options;
  // A codebook with an entry for every splat takes the SH as they are.
  const clustered = source.maxSh && entries(count, options) < count;
  const { records, sh, weights, dims } = gather(source, order, clustered);
  const job = {
    records,
    sh,
    weights,
    dims,
    count,
    ranges,
    options: { shCodebook, shIterations },
    directory,
    maxSh: source.maxSh,
  };
  // A thread takes the chunk's arrays; this thread encodes them in place.
  const moved = worker
    ? [records, sh, weights].flatMap(({ buffer }) =>
        buffer.byteLength ? [buffer] : [],
      )
    : [];
  return encoder.request(worker, job, moved);
}
