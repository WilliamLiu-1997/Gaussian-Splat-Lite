import { basename } from "#gsl/path";
import { closeSync, openSync, renameSync } from "./files.js";

let root;
export function setResultDirectory(directory) {
  root = directory;
}

export async function chunkDirectory(_staging, name) {
  const chunks = await root.getDirectoryHandle("chunks", { create: true });
  return chunks.getDirectoryHandle(name, { create: true });
}

export const outputBufferBytes = 1024 ** 2;

export async function openChunkFile(directory, name) {
  const file = await directory.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  return {
    async write(bytes, at) {
      for (let offset = 0; offset < bytes.length; offset += outputBufferBytes) {
        await stream.write({
          type: "write",
          position: at + offset,
          data: bytes.subarray(offset, offset + outputBufferBytes),
        });
      }
    },
    close: () => stream.close(),
    abort: () => stream.abort(),
  };
}

// Only the CLI builders' staging names live in the virtual filesystem.
export function openOutput(staging, path) {
  closeSync(openSync(staging, "wx"));
  return openChunkFile(root, basename(path));
}
export const publishManifest = renameSync;
