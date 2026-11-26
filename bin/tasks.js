// Task dispatch is shared. Each host owns its worker lifecycle and output I/O.
import { collect } from "#gsl/memory";
import { checkRun } from "./run-state.js";

export async function taskHandler(data, reply) {
  const check = () => checkRun(data.cancelled);
  if (data.encoder) {
    const { initialize } = await import("./rad/input.js");
    const { encodeChunk: encodeSog } = await import("./sog/encode.js");
    await initialize();
    return async (job) => {
      const result = await encodeSog(job, data.kernel, check);
      collect();
      reply(result, [result.boxes.buffer]);
    };
  }
  if (data.format) {
    const { encodeChunk: encodeRad } = await import("./rad/rad.js");
    return (chunk) => {
      const result = encodeRad(chunk, data.format);
      collect();
      const own =
        result.byteOffset === 0 &&
        result.byteLength === result.buffer.byteLength;
      reply(result, own ? [result.buffer] : []);
    };
  }
  if (data.codebook) {
    const { Nearest } = await import("./rad/cluster.js");
    const task = new Nearest(
      data.module,
      data.dims,
      data.blocks,
      data.groups,
      data.entries,
    );
    return (job) => reply(task.handle(job));
  }
  const { Scanner, Splitter } = await import("./sog/split.js");
  const task = data.scanner
    ? new Scanner(check)
    : new Splitter(data.centers, data.order, data.ids, data.starts, check);
  return (job) => {
    const result = task.handle(job);
    const transfer = [];
    if (job.kind === "bins")
      for (const { sizes, mins, maxs } of data.scanner ? result : [result])
        transfer.push(sizes.buffer, mins.buffer, maxs.buffer);
    reply(result, transfer);
  };
}
