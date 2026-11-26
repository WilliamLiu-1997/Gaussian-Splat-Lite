import { configure as radOptions } from "../bin/rad/options.js";
import { defaults, configure as sogOptions } from "../bin/sog/options.js";

export function conversionOptions(format, input, output, gib, values) {
  const options = { ...values, output, "memory-budget": String(gib) };
  return format === "sog"
    ? sogOptions({ ...defaults, ...options }, [input])
    : radOptions(options, [input]);
}
