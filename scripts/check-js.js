import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function findJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith("._")) return [];
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findJavaScriptFiles(entryPath);
      return entry.name.endsWith(".js") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

const files = (
  await Promise.all(
    ["src", "scripts", "test", "examples"].map((directory) =>
      findJavaScriptFiles(path.join(root, directory)),
    ),
  )
).flat();
files.push(
  path.join(root, "vite.config.js"),
  path.join(root, "vite.site.config.js"),
  path.join(root, "rust/build_wasm.js"),
);

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`Checked JavaScript syntax in ${files.length} files.`);
