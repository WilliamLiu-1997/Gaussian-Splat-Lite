import { removeTemporary } from "./cleanup.js";
import { requireIsolation } from "./conversion-controller.js";
import { conversionFlags } from "./convert-options.js";
import { runWorker } from "./run-worker.js";
import { startClock } from "./runtime/clock.js";
import { reserveOutput } from "./write-output.js";

export async function convertFile(file, options) {
  const { workingDirectory, format, memoryBudget, onProgress, controller } =
    options;
  const signal =
    controller && options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : (controller?.signal ?? options.signal);
  signal?.throwIfAborted();
  requireIsolation();
  if (!/\.(ply|spz)$/i.test(file.name))
    throw new Error("Expected a PLY or SPZ file.");
  if (format !== "rad" && format !== "sog")
    throw new Error("Expected rad or sog output.");
  const flags = conversionFlags(format, memoryBudget, options.flags);
  const stem = file.name.replace(/\.(ply|spz)$/i, "");
  const entryPath = format === "sog" ? "lod-meta.json" : `${stem}-lod.rad`;
  const published = new Int32Array(new SharedArrayBuffer(4));
  const directory = await reserveOutput(workingDirectory, `${stem}-${format}`, {
    signal,
  });
  let temporary;
  try {
    temporary = await reserveOutput(
      workingDirectory,
      `gsl-temp-${crypto.randomUUID()}`,
      { signal },
    );
    signal?.throwIfAborted();
    await runWorker(
      {
        file,
        format,
        entryPath,
        published,
        flags,
        cancelled: controller?.state,
        clock: controller?.clock ?? startClock(),
        scratch: temporary,
        directory,
      },
      signal,
      onProgress,
    );
  } catch (error) {
    if (!Atomics.load(published, 0)) {
      await remove(directory);
      throw error;
    }
    if (!signal?.aborted) void warn(error);
  } finally {
    if (temporary) await remove(temporary);
  }

  return { directory, entryPath };

  async function remove(handle) {
    try {
      await removeTemporary(workingDirectory, handle.name, true);
    } catch (error) {
      void warn(error);
    }
  }

  async function warn(error) {
    const log = error?.message ?? String(error);
    try {
      if (onProgress) await onProgress({ log, level: "warn" });
      else console.warn(log);
    } catch (callbackError) {
      console.warn(log, callbackError);
    }
  }
}
