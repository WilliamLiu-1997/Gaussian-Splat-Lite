import assert from "node:assert/strict";
import test from "node:test";
import { modelFromEntries } from "../examples/viewer/modelSource.js";

function entry(path, contents = "") {
  return { path, file: new File([contents], path.split("/").at(-1)) };
}

test("a dot-prefixed scene folder keeps its index and relative chunk paths", async (t) => {
  const index = entry(".capture-sog/lod-meta.json");
  const model = await modelFromEntries([
    entry(".DS_Store"),
    entry("._.capture-sog"),
    entry("__MACOSX/.capture-sog/lod-meta.json"),
    entry(".capture-sog/.backup/lod-meta.json"),
    index,
    entry(".capture-sog/chunks/a/meta.json", "a"),
    entry(".capture-sog/chunks/b/meta.json", "b"),
  ]);
  t.after(() => model.dispose());
  assert.equal(model.file, index.file);
  for (const name of ["a", "b"]) {
    const url = new URL(`chunks/${name}/meta.json`, model.url);
    const response = await fetch(model.manager.resolveURL(url.href));
    assert.equal(await response.text(), name);
  }
});

test("a hidden sibling folder is ignored when opening another scene", async (t) => {
  const index = entry("scene/lod-meta.json");
  const model = await modelFromEntries([entry(".backup/lod-meta.json"), index]);
  t.after(() => model.dispose());
  assert.equal(model.file, index.file);
});

test("a hidden RAD header and chunk are resolved outside hidden backups", async () => {
  const header = entry("scene/._capture.rad", "RAD0");
  const chunk = entry("scene/._capture-0.radc", "RADC");
  const model = await modelFromEntries([
    entry("scene/.backup/._capture.rad", "RAD0"),
    entry("scene/.backup/._capture-0.radc", "RADC"),
    entry("scene/._other.rad", "metadata"),
    header,
    chunk,
  ]);
  assert.equal(model.file, header.file);
  assert.equal(
    model.resolveFile(chunk.file.name, new AbortController().signal),
    chunk.file,
  );
});
