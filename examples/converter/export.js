import { Zip, ZipPassThrough } from "fflate";
import { removeTemporary } from "../../converter/cleanup.js";
import { reserveOutput } from "../../converter/write-output.js";
import { describeResult, filesIn } from "./results.js";

async function archive(handle, source) {
  const writer = (await handle.createWritable()).getWriter();
  const pending = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    pending.push(writer.write(bytes));
  });
  try {
    for await (const { path, file } of filesIn(source)) {
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      for (let at = 0; at < file.size; at += 1024 ** 2) {
        entry.push(
          new Uint8Array(await file.slice(at, at + 1024 ** 2).arrayBuffer()),
        );
        await Promise.all(pending.splice(0));
      }
      entry.push(new Uint8Array(), true);
      await Promise.all(pending.splice(0));
    }
    zip.end();
    await Promise.all(pending);
    await writer.close();
  } catch (error) {
    zip.terminate();
    try {
      await writer.abort();
    } catch {
      // An already-failed stream can reject abort as well.
    }
    throw error;
  }
}

export async function saveZip(scene) {
  // A late cancellation can keep the scene before its files have been counted.
  scene.details ??= await describeResult(scene.result);
  if (!scene.details.canPack)
    throw new Error("This scene exceeds the ZIP size or file count limit.");
  const handle = await reserveOutput(scene.workingFolder, scene.result.name, {
    extension: ".zip",
  });
  try {
    await archive(handle, scene.result);
  } catch (error) {
    try {
      await removeTemporary(scene.workingFolder, handle.name);
    } catch (cleanup) {
      throw new Error(`${error.message}\n${cleanup.message}`, { cause: error });
    }
    throw error;
  }
  return `Saved ${scene.workingFolder.name}/${handle.name}`;
}
