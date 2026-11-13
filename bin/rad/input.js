import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import path from "node:path";
import init, { RawDecoder } from "../decoder/decoder.js";
import { Progress } from "./progress.js";
import { Splats } from "./splats.js";

let wasm;
// A trapped WebAssembly instance is unusable, and this process cannot load a
// second copy of the module, so later inputs fail with this error instead.
let crashed;
export function initialize() {
  wasm ??= init({
    module_or_path: readFileSync(
      new URL("../decoder/decoder_bg.wasm", import.meta.url),
    ),
  });
  return wasm;
}

export async function readInput(input, maxSh, workspace, Receiver = Splats) {
  const extension = path.extname(input).toLowerCase();
  if (extension !== ".ply" && extension !== ".spz") {
    throw new Error("Input must be a .ply or .spz file");
  }
  if (crashed) {
    throw new Error(
      `Skipped after the decoder failed on an earlier input (${crashed.message}); convert this file in a new run`,
    );
  }
  const backend = await initialize();
  const splats = new Receiver(workspace, maxSh);
  // The decoder asks for `base` bytes of linear memory for each batch; the
  // workspace measures that memory with the rest of the process once it
  // has grown.
  const callback = (name, base, values) => {
    if (name !== "memory") splats.receive(name, base, values);
    else if (base > backend.memory.buffer.byteLength)
      workspace.expect(base - backend.memory.buffer.byteLength);
  };
  const fd = openSync(input, "r");
  try {
    const size = fstatSync(fd).size;
    const progress = new Progress("Reading input", size);
    const decoder = new RawDecoder(input, size, callback, splats.rawMass);
    try {
      const bytes = Buffer.allocUnsafe(1024 * 1024);
      let read = 0;
      for (;;) {
        workspace.check();
        const size = readSync(fd, bytes);
        if (!size) break;
        decoder.push(bytes.subarray(0, size));
        read += size;
        progress.update(read);
      }
      decoder.finish();
    } catch (error) {
      // A trap leaves the decoder borrowed; free() would then throw and hide
      // the original error.
      try {
        decoder.free();
      } catch {}
      throw error;
    }
    decoder.free();
    progress.finish(`${splats.length} splats, SH${splats.inputSh}`);
    return splats;
  } catch (error) {
    splats.dispose();
    if (error instanceof WebAssembly.RuntimeError) {
      crashed = error;
      throw new Error(
        `Decoder failed with an internal error (${error.message})`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}
