import { GIB } from "../units.js";

export function configure(values, inputs) {
  const options = {
    inputs,
    output: values.output,
    tempDir: values["temp-dir"],
    lodBase: Number(values["lod-base"] ?? 1.75),
    maxSh: Number(values["max-sh"] ?? 3),
    clusterSh: Number(values["cluster-sh"] ?? 10),
    budget: Number(values["memory-budget"] ?? 4) * GIB,
    chunked: Boolean(values["rad-chunked"]),
  };
  if (!Number.isSafeInteger(options.clusterSh) || options.clusterSh < 0)
    throw new Error("--cluster-sh iterations must be a nonnegative integer");
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
  if (values["sh-codebook"] !== undefined) {
    const k = Number(values["sh-codebook"]);
    if (!Number.isInteger(k) || k < 0 || k > 256)
      throw new Error("--sh-codebook must be an integer between 0 and 256 K");
    options.shCodebook = k * 1024;
  }
  if (values["within-dist"] !== undefined) {
    const sphere = values["within-dist"]
      .split(",")
      .map((value) => (value.trim() ? Number(value) : Number.NaN));
    if (sphere.length !== 4 || !sphere.every(Number.isFinite) || sphere[3] < 0)
      throw new Error(
        "--within-dist must be x,y,z,radius with finite numbers and a nonnegative radius",
      );
    options.withinDist = sphere;
  }
  if (
    !Number.isFinite(options.budget) ||
    options.budget < GIB ||
    options.budget > Number.MAX_SAFE_INTEGER
  )
    throw new Error(
      "--memory-budget must be a finite GiB number of at least 1 within the platform limit",
    );
  return options;
}
