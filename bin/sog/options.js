import { GIB } from "../units.js";
import { parseBlind } from "./blind.js";
import {
  DEFAULT_CHUNK_SPLATS_K,
  DEFAULT_LOD_DENSITY,
  DEFAULT_LOD_FACTOR,
  DEFAULT_MEMORY_GIB,
  DEFAULT_REGION_SPLATS_K,
  DEFAULT_ROOT_SPLATS_K,
} from "./lod-config.js";

export const defaults = {
  "lod-chunk-count": String(DEFAULT_CHUNK_SPLATS_K),
  "region-splats": String(DEFAULT_REGION_SPLATS_K),
  "root-splats": String(DEFAULT_ROOT_SPLATS_K),
  "lod-factor": String(DEFAULT_LOD_FACTOR),
  "lod-density": String(DEFAULT_LOD_DENSITY),
  "max-sh": "4",
  "sh-iterations": "10",
  "memory-budget": String(DEFAULT_MEMORY_GIB),
};

export function configure(values, positionals) {
  let withinDist;
  if (values["within-dist"] !== undefined) {
    withinDist = values["within-dist"]
      .split(",")
      .map((value) => (value.trim() ? Number(value) : Number.NaN));
    if (
      withinDist.length !== 4 ||
      !withinDist.every(Number.isFinite) ||
      withinDist[3] < 0
    )
      throw new Error(
        "--within-dist must be x,y,z,radius with finite numbers and a nonnegative radius",
      );
  }
  const integer = (name, min, max = 0xffffffff) => {
    const value = Number(values[name]);
    if (
      !values[name].trim() ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(`--${name} must be an integer in ${min}..${max}`);
    return value;
  };
  const countInK = (name, max = 0xffffffff) =>
    integer(name, 1, Math.floor(max / 1024)) * 1024;
  const factor = Number(values["lod-factor"]);
  const density = Number(values["lod-density"]);
  const budget = Number(values["memory-budget"]);
  if (!Number.isFinite(factor) || factor <= 1)
    throw new Error("--lod-factor must be finite and greater than 1");
  if (!values["lod-density"].trim() || !(density >= 0 && density <= 1))
    throw new Error("--lod-density must be a number in 0..1");
  if (
    !Number.isFinite(budget) ||
    budget < 1 ||
    !Number.isSafeInteger(Math.floor(budget * GIB))
  )
    throw new Error("--memory-budget must be a finite GiB value of at least 1");
  return {
    inputs: positionals,
    output: values.output,
    tempDir: values["temp-dir"],
    lodChunkCount: countInK("lod-chunk-count"),
    regionSplats: countInK("region-splats"),
    rootSplats: countInK("root-splats"),
    lodFactor: factor,
    lodDensity: density,
    maxSh: integer("max-sh", 0, 4),
    withinDist,
    blind: parseBlind(values["sog-blind"]),
    shCodebook:
      values["sh-codebook"] === undefined
        ? undefined
        : countInK("sh-codebook", 262144),
    shIterations: integer("sh-iterations", 0, Number.MAX_SAFE_INTEGER),
    budget: budget * GIB,
  };
}
