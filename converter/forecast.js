import { MAX_CHUNK_SPLATS } from "../bin/sog/image-limits.js";
import { conversionOptions } from "./convert-options.js";
import { estimateBatch } from "./estimate.js";
import { memoryGiB, options, outputFormat } from "./options.js";

const form = document.querySelector("#form");
const el = (name) => document.getElementById(`estimate-${name}`);

function size(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index = Math.min(
    units.length - 1,
    Math.max(0, Math.floor(Math.log2(bytes) / 10)),
  );
  return `≈ ${Number((bytes / 1024 ** index).toPrecision(2))} ${units[index]}`;
}

function show(note, estimate) {
  el("levels").textContent = estimate?.levels ?? "—";
  for (const key of ["disk", "memory", "output"])
    el(key).textContent = estimate ? size(estimate[key]) : "—";
  el("note").textContent = note;
}

function regionWarning(sources, { regionSplats, lodChunkCount }) {
  const limit = Math.min(lodChunkCount, MAX_CHUNK_SPLATS);
  const names = sources
    .filter(({ count }) => Math.min(count, regionSplats) > limit)
    .map(({ file }) => file.name);
  if (!names.length) return;
  const fix =
    limit === MAX_CHUNK_SPLATS
      ? "Reduce Points per region."
      : "Increase Points per chunk or reduce Points per region.";
  return `A region may exceed the ${limit.toLocaleString("en-US")}-point chunk limit in ${names.join(", ")}. ${fix}`;
}

function estimate(sources, format, values, notes) {
  if (!sources.length) return;
  if (form.matches(":invalid")) {
    notes.push("Check your conversion settings to see an estimate.");
    return;
  }
  const config = conversionOptions(
    format,
    sources[0].file.name,
    "",
    memoryGiB(),
    values,
  );
  if (format === "sog") {
    const warning = regionWarning(sources, config);
    if (warning) notes.push(warning);
  }
  const unreadable = sources.find(({ count }) => count === undefined);
  if (unreadable) {
    notes.push(
      `Estimate unavailable for ${unreadable.file.name}. Could not read its source header.`,
    );
    return;
  }
  const result = estimateBatch(
    sources,
    format,
    config,
    navigator.hardwareConcurrency || 1,
  );
  notes.push(
    "Disk space includes room for temporary files and saved scenes. Saving a ZIP needs additional space.",
  );
  if (config.withinDist)
    notes.push("Sizes and detail levels are shown before cropping.");
  if (sources.length > 1)
    notes.push("Output is the batch total. Disk and memory show peak usage.");
  return result;
}

export function showForecast(sources) {
  if (!sources) {
    show("Reading source headers…");
    return;
  }
  const format = outputFormat();
  const values = options();
  const eligible = [];
  const skipped = [];
  for (const source of sources) {
    const { file } = source;
    let problem = source.problem;
    if (
      format === "sog" &&
      values["sog-blind"]?.length &&
      /\.spz$/i.test(file.name)
    )
      problem =
        "Blind fields require PLY input. Remove the Blind fields to include this SPZ.";
    if (problem) skipped.push(`Skipping ${file.name}. ${problem}`);
    else eligible.push(source);
  }
  const notes = [...skipped];
  let result;
  try {
    result = estimate(eligible, format, values, notes);
  } catch (error) {
    notes.push(error.message);
  }
  show(notes.join("\n"), result);
  return { files: eligible.map(({ file }) => file), skipped };
}
