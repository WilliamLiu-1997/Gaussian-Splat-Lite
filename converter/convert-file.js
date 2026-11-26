import { removeTemporary } from "./cleanup.js";
import { describeResult } from "./results.js";
import { runWorker } from "./run-worker.js";
import { reserveOutput } from "./write-output.js";

export async function convertFile(
  file,
  workingFolder,
  { format, gib, values },
  signal,
  update,
) {
  const stem = file.name.replace(/\.(ply|spz)$/i, "");
  const directory = await reserveOutput(workingFolder, `${stem}-${format}`);
  try {
    const temporary = await reserveOutput(
      workingFolder,
      `gsl-temp-${crypto.randomUUID()}`,
    );
    try {
      signal.throwIfAborted();
      await runWorker(
        {
          file,
          format,
          gib,
          modelName: `${stem}-lod.rad`,
          values,
          scratch: temporary,
          directory,
        },
        signal,
        update,
      );
    } finally {
      try {
        await removeTemporary(workingFolder, temporary.name, true);
      } catch (error) {
        update({ log: error.message, level: "warn" });
      }
    }
  } catch (error) {
    await removeTemporary(workingFolder, directory.name, true);
    throw error;
  }

  const scene = { result: directory, workingFolder, format, stem };
  if (signal.aborted) return scene;
  const label = "Preparing preview files";
  update({ phase: { name: "preview", unit: label } });
  update({ progress: { label, percent: 0, line: label, done: false } });
  try {
    scene.details = await describeResult(directory, signal);
  } catch (error) {
    if (signal.aborted) return scene;
    update({
      log: `Could not read output details: ${error.message}`,
      level: "warn",
    });
  }
  const summary = scene.details
    ? `Preview ready · ${scene.details.count} files`
    : "Scene saved · File details unavailable";
  update({
    progress: {
      label: scene.details ? label : "Scene saved",
      percent: 100,
      done: true,
      line: summary,
    },
  });
  return scene;
}
