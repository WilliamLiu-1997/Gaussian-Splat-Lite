import { convert as rad } from "../bin/rad/convert.js";
import { initialize } from "../bin/rad/input.js";
import { Workspace } from "../bin/rad/storage.js";
import { checkRun } from "../bin/run-state.js";
import { convert as sog } from "../bin/sog/convert.js";
import { conversionOptions } from "./convert-options.js";
import { useClock } from "./runtime/clock.js";
import { externalHandle } from "./runtime/external.js";
import { mkdirSync, mount } from "./runtime/files.js";
import { trackDecoder } from "./runtime/memory.js";
import { setResultDirectory } from "./runtime/output.js";
import { clusterUrl, decoderUrl } from "./runtime/wasm.js";

async function compile(url, name) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`Could not load ${name}: ${error.message}`, {
      cause: error,
    });
  }
}

self.onmessage = async ({
  data: {
    file,
    format,
    directory,
    entryPath,
    published,
    flags,
    scratch,
    cancelled,
    clock,
  },
}) => {
  try {
    checkRun(cancelled);
    useClock(clock);
    const phase = (name, unit) =>
      self.postMessage({
        phase: unit === undefined ? { name } : { name, unit },
      });
    for (const method of ["log", "warn"])
      console[method] = (...args) =>
        self.postMessage({ log: args.join(" "), level: method });
    const input = /\.ply$/i.test(file.name) ? "/input.ply" : "/input.spz";
    const entry = `/scene/${entryPath}`;
    const output = format === "sog" ? "/scene" : entry;
    const options = conversionOptions(format, input, output, flags);
    const disk = new Worker(new URL("./disk-worker.js", import.meta.url), {
      type: "module",
      name: "GSL temporary disk",
    });
    try {
      const handle = await externalHandle(scratch, disk);
      mount(input, file, handle, { entry, published });
      setResultDirectory(directory);
      mkdirSync("/scene");
      const [decoder, kernel] = await Promise.all([
        compile(decoderUrl, "decoder_bg.wasm"),
        options.maxSh && options.shCodebook !== 0
          ? compile(clusterUrl, "cluster.wasm")
          : undefined,
      ]);
      trackDecoder((await initialize(decoder)).memory);
      const workspace = () =>
        new Workspace(options.budget, handle.submit, undefined, cancelled);
      await (format === "sog" ? sog : rad)(
        input,
        options,
        kernel,
        workspace,
        phase,
      );
      handle.flush();
    } finally {
      disk.terminate();
    }
    self.postMessage({ done: true });
  } catch (error) {
    self.postMessage({ error: error.message ?? String(error) });
  }
};
