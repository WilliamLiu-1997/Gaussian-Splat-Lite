import clusterUrl from "../bin/decoder/cluster.wasm?url";
import decoderUrl from "../bin/decoder/decoder_bg.wasm?url";
import { convert as rad } from "../bin/rad/convert.js";
import { initialize } from "../bin/rad/input.js";
import { Workspace } from "../bin/rad/storage.js";
import { convert as sog } from "../bin/sog/convert.js";
import { conversionOptions } from "./convert-options.js";
import { useClock } from "./runtime/clock.js";
import { externalHandle } from "./runtime/external.js";
import { mkdirSync, mount } from "./runtime/files.js";
import { trackDecoder } from "./runtime/memory.js";
import { setResultDirectory } from "./runtime/output.js";

async function compile(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not load the converter (${response.status}).`);
  return WebAssembly.compile(await response.arrayBuffer());
}

self.onmessage = async ({
  data: {
    file,
    format,
    gib,
    directory,
    modelName,
    values,
    scratch,
    cancelled,
    clock,
  },
}) => {
  try {
    useClock(clock);
    const phase = (name, unit) => self.postMessage({ phase: { name, unit } });
    for (const method of ["log", "warn"])
      console[method] = (...args) =>
        self.postMessage({ log: args.join(" "), level: method });
    const handle = await externalHandle(scratch);
    try {
      const input = /\.ply$/i.test(file.name) ? "/input.ply" : "/input.spz";
      mount(input, file, handle);
      setResultDirectory(directory);
      mkdirSync("/scene");
      const output = format === "sog" ? "/scene" : `/scene/${modelName}`;
      const options = conversionOptions(format, input, output, gib, values);
      const [decoder, kernel] = await Promise.all([
        compile(decoderUrl),
        options.maxSh && options.shCodebook !== 0
          ? compile(clusterUrl)
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
    } finally {
      handle.close();
    }
    self.postMessage({ done: true });
  } catch (error) {
    self.postMessage({ error: error.message ?? String(error) });
  }
};
