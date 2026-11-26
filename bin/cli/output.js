import {
  constants,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function openWriter(path, workspace) {
  const fd = openSync(path, "wx");
  function release() {
    try {
      workspace?.writeback.synced(fd);
    } finally {
      closeSync(fd);
    }
  }
  return {
    write(data, at) {
      if (workspace) workspace.write(fd, data, at);
      else writeFileSync(fd, data);
    },
    close() {
      try {
        fsyncSync(fd);
      } finally {
        release();
      }
    },
    abort: release,
  };
}

export const outputBufferBytes = 0;
export const chunkDirectory = (staging) => staging;
export const openChunkFile = (directory, name) =>
  openWriter(join(directory, name));
export const openOutput = (staging, _output, workspace) =>
  openWriter(staging, workspace);
export const publishManifest = (staging, output) =>
  copyFileSync(staging, output, constants.COPYFILE_EXCL);
