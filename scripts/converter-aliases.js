import { fileURLToPath } from "node:url";

export const converterAliases = { "#gsl/path": "@jspm/core/nodelibs/path" };
for (const name of ["clock", "files", "host", "memory", "output", "threads"])
  converterAliases[`#gsl/${name}`] = fileURLToPath(
    new URL(`../converter/runtime/${name}.js`, import.meta.url),
  );
