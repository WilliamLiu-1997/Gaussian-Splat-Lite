import { runTime } from "#gsl/clock";
import { basename, dirname, extname, join } from "#gsl/path";
import { readInput } from "../rad/input.js";
import { GIB } from "../rad/storage.js";
import { buildLevels } from "./lod.js";
import { Levels, buildRegions } from "./regions.js";
import { Splats } from "./splats.js";
import { checkOutput, writeScene } from "./write-scene.js";

export async function convert(
  input,
  options,
  kernel,
  createWorkspace,
  onPhase,
) {
  const directory =
    options.output ??
    join(dirname(input), `${basename(input, extname(input))}-sog`);
  const output = join(directory, "lod-meta.json");
  checkOutput(output);
  const workspace = createWorkspace();
  const started = runTime();
  let splats;
  let levels;
  let regions;
  try {
    console.log(
      `${input} → ${output}\nMemory target: ${(options.budget / GIB).toFixed(3)} GiB`,
    );
    onPhase?.("read", "Reading input");
    splats = await readInput(input, options.maxSh, workspace, Splats, {
      withinDist: options.withinDist,
      blind: options.blind,
    });
    splats.retain();
    if (splats.maxSh < splats.inputSh)
      console.log(`Keeping SH0–SH${splats.maxSh}`);
    onPhase?.("lod");
    levels = await buildLevels(
      splats,
      options.rootSplats,
      options.lodFactor,
      options.lodDensity,
    );
    const rows = new Levels(levels);
    onPhase?.("partition", "Partitioning regions");
    regions = await buildRegions(rows, options.regionSplats);
    onPhase?.("encode", "Writing SOG chunks");
    await writeScene(rows, regions, output, options, kernel);
    console.log(
      `Wrote ${output} in ${((runTime() - started) / 1000).toFixed(2)}s`,
    );
  } finally {
    regions?.order.dispose();
    for (const level of levels ?? (splats ? [splats] : [])) level.dispose();
    workspace.dispose();
  }
}
