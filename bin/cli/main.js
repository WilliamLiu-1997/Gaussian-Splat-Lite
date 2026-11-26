import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { codebookKernel } from "./modules.js";
import { cliWorkspace, start } from "./worker.js";

export async function main(entry, format, convert, parse, help) {
  try {
    if (isMainThread) {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 12))
        throw new Error(`gsl-build-${format} requires Node.js 22.12 or later`);
      const options = parse(process.argv.slice(2));
      if (options) await start(entry, options);
      else console.log(help);
      return;
    }

    for (const method of ["log", "warn", "error"])
      console[method] = (...args) => parentPort.postMessage({ method, args });
    const { options, cancelled } = workerData;
    const kernel =
      options.maxSh && options.shCodebook !== 0 ? codebookKernel() : undefined;
    let failed = 0;
    for (const input of options.inputs) {
      if (Atomics.load(cancelled, 0)) break;
      try {
        await convert(input, options, kernel, () =>
          cliWorkspace(options, cancelled, `gsl-build-${format}-`),
        );
      } catch (error) {
        if (Atomics.load(cancelled, 0)) break;
        console.error(`${input}: ${error.message ?? error}`);
        failed++;
      }
    }
    if (failed) throw new Error(`${failed} conversion(s) failed`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
