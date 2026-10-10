import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const typesDirectory = fileURLToPath(
  new URL("../dist/types/", import.meta.url),
);
const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));

async function findDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findDeclarationFiles(entryPath);
      }
      return entry.name.endsWith(".d.ts") && !entry.name.startsWith("._")
        ? [entryPath]
        : [];
    }),
  );
  return files.flat();
}

function toCommonJsDeclarations(source) {
  return source.replace(
    /((?:from\s+|import\s*\(\s*)["'])(\.\.?\/[^"']+)(["'])/g,
    (_match, prefix, specifier, suffix) => {
      let commonJsSpecifier = specifier;
      if (/\.m?js$/.test(specifier)) {
        commonJsSpecifier = specifier.replace(/\.m?js$/, ".cjs");
      } else if (!path.extname(specifier)) {
        commonJsSpecifier = `${specifier}.cjs`;
      }
      return `${prefix}${commonJsSpecifier}${suffix}`;
    },
  );
}

await rm(typesDirectory, { recursive: true, force: true });
const declarationFiles = await findDeclarationFiles(sourceDirectory);
for (const declarationFile of declarationFiles) {
  const source = await readFile(declarationFile, "utf8");
  const outputFile = path.join(
    typesDirectory,
    path.relative(sourceDirectory, declarationFile),
  );
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, source);
  const commonJsFile = outputFile.replace(/\.d\.ts$/, ".d.cts");
  await writeFile(commonJsFile, toCommonJsDeclarations(source));
}

// ESM declarations can safely re-export a CommonJS declaration surface when
// the package has no default export. This keeps both entry points identical
// while retaining the checked-in index.d.ts for direct declaration access.
await writeFile(
  path.join(typesDirectory, "index.d.mts"),
  'export * from "./index.cjs";\n',
);
