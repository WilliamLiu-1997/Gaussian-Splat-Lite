#!/usr/bin/env node

import path from "node:path";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { readInput } from "./rad/input.js";
import { buildLod } from "./rad/lod.js";
import { Pool } from "./rad/parallel.js";
import { checkOutput, writeRad } from "./rad/rad.js";
import { GIB, Workspace } from "./rad/storage.js";

const help = `Convert PLY or SPZ files to RAD with levels of detail (LOD).

Usage: gsl-build-lod <input> [more inputs...] [options]
       npm run build-lod -- <input> [more inputs...] [options]

Inputs: PLY, SPZ.
Output: <input-stem>-lod.rad. Existing files are not overwritten.

Options:
  --lod-base <base>      LOD spacing (default: 1.75, range: 1.1..16)
  --max-sh <0..3>        Maximum SH degree (default: 3)
  --within-dist <x,y,z,radius>
                        Keep splat centers within this sphere (input coordinates)
  --rad-chunked          Write a .rad header and separate .radc files
  --memory-budget <GiB>  Target memory in GiB (default: 4, minimum: 1)
  --temp-dir <path>      Temporary file location (default: system temp)
  -o, --output <path>    Output .rad path (one input only)
  -h, --help             Show this help

SH4 inputs are accepted; coefficients above --max-sh are discarded.
The memory target covers the whole conversion, worker threads included.
No compilation is required.`;

function parse(args) {
  const options = {
    inputs: [],
    lodBase: 1.75,
    maxSh: 3,
    budget: 4 * GIB,
    chunked: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return;
    if (arg === "--") {
      options.inputs.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--rad-chunked") {
      options.chunked = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      options.inputs.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal < 0 ? arg : arg.slice(0, equal);
    const key = {
      "--lod-base": "lodBase",
      "--max-sh": "maxSh",
      "--within-dist": "withinDist",
      "--memory-budget": "budget",
      "--temp-dir": "tempDir",
      "-o": "output",
      "--output": "output",
    }[name];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value) throw new Error(`${name} requires a value`);
    options[key] = ["lodBase", "maxSh", "budget"].includes(key)
      ? Number(value) * (key === "budget" ? GIB : 1)
      : value;
  }
  if (
    !Number.isFinite(options.lodBase) ||
    options.lodBase < 1.1 ||
    options.lodBase > 16
  )
    throw new Error("--lod-base must be between 1.1 and 16");
  if (
    !Number.isInteger(options.maxSh) ||
    options.maxSh < 0 ||
    options.maxSh > 3
  )
    throw new Error("--max-sh must be an integer between 0 and 3");
  if (options.withinDist !== undefined) {
    const values = options.withinDist
      .split(",")
      .map((value) => (value.trim() ? Number(value) : Number.NaN));
    if (values.length !== 4 || !values.every(Number.isFinite) || values[3] < 0)
      throw new Error(
        "--within-dist must be x,y,z,radius with finite numbers and a nonnegative radius",
      );
    options.withinDist = values;
  }
  if (
    !Number.isFinite(options.budget) ||
    options.budget < GIB ||
    options.budget > Number.MAX_SAFE_INTEGER
  )
    throw new Error(
      "--memory-budget must be a finite GiB number of at least 1 within the platform limit",
    );
  if (!options.inputs.length) throw new Error(help);
  if (options.output && options.inputs.length !== 1)
    throw new Error("--output requires exactly one input");
  return options;
}

async function convert(input, options, cancelled) {
  const output =
    options.output ??
    path.join(
      path.dirname(input),
      `${path.basename(input, path.extname(input))}-lod.rad`,
    );
  checkOutput(output, options.chunked);
  const workspace = new Workspace(options.budget, options.tempDir, cancelled);
  const start = performance.now();
  console.log(
    `${input} -> ${output}\nMemory target: ${(options.budget / GIB).toFixed(3)} GiB`,
  );
  // Worker threads for the LOD, closed before writing starts its own.
  let pool;
  try {
    workspace.check();
    const splats = await readInput(input, options.maxSh, workspace);
    const count = splats.length;
    pool = new Pool(workspace, count);
    splats.retain(pool, options.withinDist);
    console.log(
      `Read ${count} splats, SH${splats.inputSh}, in ${((performance.now() - start) / 1000).toFixed(2)}s`,
    );
    if (splats.inputSh > splats.maxSh)
      console.log(
        `Keeping SH0–SH${splats.maxSh}; higher coefficients are discarded for RAD output.`,
      );
    if (splats.invalid)
      console.log(
        `Removed ${splats.invalid} splats with NaN or infinite values or a zero rotation`,
      );
    const empty = count - splats.invalid - splats.cropped - splats.length;
    if (empty) console.log(`Removed ${empty} empty splats`);
    if (splats.cropped)
      console.log(`Removed ${splats.cropped} splats outside --within-dist`);
    if (!splats.length) throw new Error("Input contains no usable splats");
    const leaves = splats.length;
    const lodStart = performance.now();
    buildLod(splats, options.lodBase, pool);
    await pool.close();
    console.log(
      `Built ${splats.length} LOD splats from ${leaves} leaves in ${((performance.now() - lodStart) / 1000).toFixed(2)}s`,
    );
    const bytes = await writeRad(
      splats,
      output,
      options.chunked,
      options.lodBase,
    );
    console.log(
      `Wrote ${(bytes / 1048576).toFixed(2)} MiB in ${((performance.now() - start) / 1000).toFixed(2)}s total`,
    );
  } finally {
    await pool?.close();
    workspace.dispose();
  }
}

async function run(options, cancelled) {
  let failed = 0;
  for (const input of options.inputs) {
    if (Atomics.load(cancelled, 0)) return;
    try {
      await convert(input, options, cancelled);
    } catch (error) {
      if (Atomics.load(cancelled, 0)) return;
      console.error(`${input}: ${error.message ?? error}`);
      failed++;
    }
  }
  if (failed) throw new Error(`${failed} conversion(s) failed`);
}

// Keep signal handling responsive while the conversion runs synchronous code.
// The worker observes cancellation and unwinds its existing catch/finally blocks.
async function start(options) {
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  let progressLine = "";
  const endProgress = () => {
    if (progressLine) process.stdout.write("\n");
    progressLine = "";
  };
  const print = ({ method, args }) => {
    if (method === "progress") {
      const [line, done] = args;
      if (process.stdout.isTTY) {
        const width = process.stdout.columns;
        const text = !done && width ? line.slice(0, width - 1) : line;
        process.stdout.write(`\r\x1b[2K${text}${done ? "\n" : ""}`);
        progressLine = done ? "" : text;
      } else console.log(line);
    } else {
      // Insert logs above the live progress instead of leaving a stale row.
      if (progressLine) process.stdout.write("\r\x1b[2K");
      console[method](...args);
      if (progressLine) process.stdout.write(progressLine);
    }
  };
  const interrupt = (signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (Atomics.compareExchange(cancelled, 0, 0, code) === 0) {
      endProgress();
      console.error(`${signal}: cancelling conversion and cleaning up...`);
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const code = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { options, cancelled },
      });
      worker.on("message", print);
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    process.exitCode = Atomics.load(cancelled, 0) || code;
  } finally {
    endProgress();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

try {
  if (!isMainThread) {
    // Worker stdout buffers later writes until its event loop yields.
    // Forward logs directly so synchronous conversion keeps showing progress.
    for (const method of ["log", "warn", "error"])
      console[method] = (...args) => parentPort.postMessage({ method, args });
    await run(workerData.options, workerData.cancelled);
  } else {
    const options = parse(process.argv.slice(2));
    if (!options) console.log(help);
    else await start(options);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
