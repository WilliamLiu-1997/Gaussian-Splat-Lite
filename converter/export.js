import { Zip, ZipPassThrough } from "fflate";
import { removeTemporary } from "./cleanup.js";
import { filesIn } from "./results.js";
import { reserveOutput } from "./write-output.js";

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
    await writer.abort();
    throw error;
  }
}

export async function saveZip(scene) {
  const handle = await reserveOutput(
    scene.workingFolder,
    scene.result.name,
    ".zip",
  );
  try {
    await archive(handle, scene.result);
  } catch (error) {
    await removeTemporary(scene.workingFolder, handle.name);
    throw error;
  }
  return `Saved ${scene.workingFolder.name}/${handle.name}`;
}
