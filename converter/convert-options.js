import { configure as radOptions } from "../bin/rad/options.js";
import { defaults, configure as sogOptions } from "../bin/sog/options.js";

const common = ["max-sh", "sh-codebook", "within-dist"];
const allowed = {
  rad: new Set([...common, "lod-base", "cluster-sh", "rad-chunked"]),
  sog: new Set([
    ...common,
    ...Object.keys(defaults).filter((key) => key !== "memory-budget"),
    "sog-blind",
  ]),
};

// Capture a job's settings as plain CLI values before the first storage await.
export function conversionFlags(format, memoryBudget, flags = {}) {
  if (Object.prototype.toString.call(flags) !== "[object Object]")
    throw new TypeError("flags must be an object of converter options");
  const options = {};
  if (memoryBudget !== undefined)
    options["memory-budget"] = String(memoryBudget);
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    if (!allowed[format].has(key))
      throw new Error(`Unknown ${format.toUpperCase()} option: --${key}`);
    if (key === "sog-blind") {
      const fields = Array.isArray(value) && [...value];
      if (!fields || fields.some((field) => typeof field !== "string"))
        throw new TypeError("--sog-blind must be an array of field strings");
      options[key] = fields;
    } else if (key === "rad-chunked") {
      if (typeof value !== "boolean")
        throw new TypeError("--rad-chunked must be a boolean");
      options[key] = value;
    } else if (
      typeof value === "number" ||
      (typeof value === "string" && value.trim())
    ) {
      options[key] = String(value);
    } else {
      throw new Error(`--${key} requires a value`);
    }
  }
  return options;
}

export function conversionOptions(format, input, output, flags) {
  const options = { ...flags, output };
  return format === "sog"
    ? sogOptions({ ...defaults, ...options }, [input])
    : radOptions(options, [input]);
}
