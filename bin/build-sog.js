#!/usr/bin/env node

import { basename, dirname, extname, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { start } from "./cli-worker.js";
import { codebookKernel } from "./rad/cluster.js";
import { readInput } from "./rad/input.js";
import { GIB, Workspace } from "./rad/storage.js";
import { buildLevels } from "./sog/lod.js";
import { help, parse } from "./sog/options.js";
import { Levels, buildRegions } from "./sog/regions.js";
import { Splats } from "./sog/splats.js";
import { checkOutput, writeScene } from "./sog/write-scene.js";

async function convert(input, options, kernel, cancelled) {
  const directory =
    options.output ??
    join(dirname(input), `${basename(input, extname(input))}-sog`);
  const output = join(directory, "lod-meta.json");
  checkOutput(output);
  const workspace = new Workspace(
    options.budget,
    (files, state) =>
      parentPort.postMessage({ method: "writeback", args: [files, state] }),
    options.tempDir,
    cancelled,
    "gsl-build-sog-",
  );
  const started = performance.now();
  let splats;
  let levels;
  let regions;
  try {
    console.log(
      `${input} → ${output}\nMemory target: ${(options.budget / GIB).toFixed(3)} GiB`,
    );
    splats = await readInput(input, options.maxSh, workspace, Splats);
    splats.retain(options.withinDist);
    if (splats.maxSh < splats.inputSh)
      console.log(`Keeping SH0–SH${splats.maxSh}`);
    levels = await buildLevels(splats, options.rootSplats, options.lodFactor);
    const rows = new Levels(levels);
    regions = await buildRegions(rows, options.regionSplats);
    await writeScene(rows, regions, output, options, kernel);
    console.log(
      `Wrote ${output} in ${((performance.now() - started) / 1000).toFixed(2)}s`,
    );
  } finally {
    regions?.order.dispose();
    for (const level of levels ?? (splats ? [splats] : [])) level.dispose();
    workspace.dispose();
  }
}

async function run(options, cancelled) {
  const kernel = options.maxSh ? codebookKernel() : undefined;
  let failed = 0;
  for (const input of options.inputs) {
    if (Atomics.load(cancelled, 0)) break;
    try {
      await convert(input, options, kernel, cancelled);
    } catch (error) {
      if (Atomics.load(cancelled, 0)) break;
      console.error(`${input}: ${error.message ?? error}`);
      failed++;
    }
  }
  if (failed) throw new Error(`${failed} conversion(s) failed`);
}

try {
  if (isMainThread) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12))
      throw new Error("gsl-build-sog requires Node.js 22.12 or later");
    const options = parse(process.argv.slice(2));
    if (options) await start(new URL(import.meta.url), options);
    else console.log(help);
  } else {
    for (const method of ["log", "warn", "error"])
      console[method] = (...args) => parentPort.postMessage({ method, args });
    await run(workerData.options, workerData.cancelled);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
