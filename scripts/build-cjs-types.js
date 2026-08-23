import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const typesDirectory = fileURLToPath(
  new URL("../dist/types/", import.meta.url),
);

async function findDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findDeclarationFiles(entryPath);
      }
      return entry.name.endsWith(".d.ts") ? [entryPath] : [];
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

const declarationFiles = await findDeclarationFiles(typesDirectory);
for (const declarationFile of declarationFiles) {
  const source = await readFile(declarationFile, "utf8");
  const commonJsFile = declarationFile.replace(/\.d\.ts$/, ".d.cts");
  await writeFile(commonJsFile, toCommonJsDeclarations(source));
}

// ESM declarations can safely re-export a CommonJS declaration surface when
// the package has no default export. This keeps both entry points identical
// while leaving Vite's generated index.d.ts intact for repeatable builds.
await writeFile(
  path.join(typesDirectory, "index.d.mts"),
  'export * from "./index.cjs";\n',
);
