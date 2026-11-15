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

// Gathers the chunk of the splats `order` of `source` into `buffer` and has
// `worker` of `encoder`, a thread or this one, encode its images, cluster
// its SH, write its files into `directory` and measure its `ranges`; see
// chunkBuffer() and encodeChunk().
export async function writeChunk(
  source,
  order,
  ranges,
  directory,
  options,
  encoder,
  worker,
  buffer,
  input,
) {
  const { workspace } = source;
  const { blind, model } = input;
  const count = order.length;
  // Without a thread, the images of the chunk before stay on this thread
  // until collected, and this chunk's would add to them.
  if (worker) workspace.adjust();
  else workspace.settle();
  const { shCodebook, shIterations } = options;
  // A codebook with an entry for every splat takes the SH as they are.
  const clustered = source.maxSh && entries(count, options) < count;
  const job = {
    ...gather(source, order, clustered, buffer, blind),
    model,
    count,
    ranges,
    options: { shCodebook, shIterations },
    directory,
    maxSh: source.maxSh,
  };
  return encoder.request(worker, job);
}
