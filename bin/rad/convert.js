import { runTime } from "#gsl/clock";
import path from "#gsl/path";
import { clusterSh } from "./cluster.js";
import { readInput } from "./input.js";
import { buildLod } from "./lod.js";
import { Pool } from "./parallel.js";
import { checkOutput, writeRad } from "./rad.js";
import { Splats } from "./splats.js";
import { GIB } from "./storage.js";

export async function convert(
  input,
  options,
  kernel,
  createWorkspace,
  onPhase,
) {
  const output =
    options.output ??
    path.join(
      path.dirname(input),
      `${path.basename(input, path.extname(input))}-lod.rad`,
    );
  checkOutput(output, options.chunked);
  const workspace = createWorkspace();
  const start = runTime();
  console.log(
    `${input} -> ${output}\nMemory target: ${(options.budget / GIB).toFixed(3)} GiB`,
  );
  // Worker threads for the LOD, closed before writing starts its own.
  let pool;
  try {
    workspace.check();
    // The pool checks the splats as they arrive, and builds the LOD.
    onPhase?.("read", "Reading input");
    const splats = await readInput(input, options.maxSh, workspace, Splats, {
      withinDist: options.withinDist,
      start: (count) => {
        pool = new Pool(workspace, count);
        pool.ready();
        return pool;
      },
      reserve: (bytes, memory) =>
        pool ? pool.reserve(bytes, memory) : workspace.expect(bytes),
    });
    const count = splats.length;
    splats.retain();
    console.log(
      `Read ${count} splats, SH${splats.inputSh}, in ${((runTime() - start) / 1000).toFixed(2)}s`,
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
    const lodStart = runTime();
    onPhase?.("lod");
    const format = buildLod(splats, options.lodBase, pool, options.shCodebook);
    await pool.close();
    pool = undefined;
    console.log(
      `Built ${splats.length} LOD splats from ${leaves} leaves in ${((runTime() - lodStart) / 1000).toFixed(2)}s`,
    );
    let codebook;
    if (kernel && !splats.maxSh)
      console.log("No SH coefficients to cluster; writing without a codebook");
    else if (kernel) {
      onPhase?.("cluster");
      const clusterStart = runTime();
      codebook = await clusterSh(
        splats,
        options.clusterSh,
        kernel,
        options.shCodebook,
      );
      // RAD encoding now reads only the codebook and labels.
      for (const column of splats.sh) column.dispose();
      splats.weight.dispose();
      console.log(
        `Clustered SH into ${codebook.count} codes in ${((runTime() - clusterStart) / 1000).toFixed(2)}s`,
      );
    }
    onPhase?.("encode", "Encoding RAD chunks");
    const bytes = await writeRad(
      splats,
      output,
      options.chunked,
      codebook,
      format,
    );
    console.log(
      `Wrote ${(bytes / 1048576).toFixed(2)} MiB in ${((runTime() - start) / 1000).toFixed(2)}s total`,
    );
  } finally {
    await pool?.close();
    workspace.dispose();
  }
}
