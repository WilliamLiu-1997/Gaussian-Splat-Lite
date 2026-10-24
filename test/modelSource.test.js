import assert from "node:assert/strict";
import test from "node:test";
import {
  fileTypeFor,
  modelFromLocalFiles,
  modelFromUrl,
  sceneTypeFor,
} from "../examples/viewer/modelSource.js";

function localFile(path, contents = "data") {
  const file = new File([contents], path.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

test("scene extensions remain separate from ordinary splat file types", () => {
  assert.equal(sceneTypeFor({ name: "Scene.LCC" }), "lcc");
  assert.equal(sceneTypeFor({ name: "Scene.lcc2" }), "lcc2");
  assert.equal(fileTypeFor({ name: "Scene.LCC" }), undefined);
  assert.equal(fileTypeFor({ name: "Scene.lcc2" }), undefined);
  assert.equal(sceneTypeFor({ name: "scene.lcc2.zip" }), undefined);
  assert.equal(
    modelFromUrl("https://example.com/Scene.lcc2?token=1").name,
    "Scene.lcc2",
  );
});

test("local scenes take priority over payload and mesh files", () => {
  const files = [
    localFile("export/scene.lcc2"),
    localFile("export/data/3dgs/model.sog"),
    localFile("export/data/mesh/model.ply"),
    localFile("export/data/3dgs/images/means.webp"),
    localFile("other/images/means.webp"),
  ];
  const source = modelFromLocalFiles(files);
  try {
    assert.equal(source.file, files[0]);
    const payload = new URL("data/3dgs/model.sog", source.url).href;
    const image = new URL("images/means.webp", payload).href;
    assert.match(source.manager.resolveURL(payload), /^blob:/);
    assert.match(source.manager.resolveURL(image), /^blob:/);
    assert.equal(source.manager.getFileSize(image), files[3].size);
    assert.throws(
      () => source.manager.resolveURL(new URL("means.webp", source.url).href),
      /Select the companion file/,
    );
    assert.throws(
      () => source.manager.resolveURL("https://other.invalid/model.sog"),
      /Select the companion file/,
    );
  } finally {
    source.dispose();
  }
  assert.throws(() => source.manager.resolveURL(source.url), /disposed/);
});

test("directory scenes never substitute a different folder's companion", () => {
  const source = modelFromLocalFiles([
    localFile("export/scene.lcc2"),
    localFile("export/data/south/shared.spz", "wrong geometry"),
  ]);
  try {
    const missing = new URL("data/north/shared.spz", source.url).href;
    assert.equal(source.manager.getFileSize(missing), null);
    assert.throws(
      () => source.manager.resolveURL(missing),
      /Select the companion file/,
    );
  } finally {
    source.dispose();
  }
});

test("flat file selections can resolve nested companion names by basename", async () => {
  const source = modelFromLocalFiles([
    localFile("scene.lcc2"),
    localFile("shared.spz", "selected geometry"),
  ]);
  try {
    const payload = new URL("data/north/shared.spz", source.url).href;
    assert.equal(source.manager.getFileSize(payload), 17);
    const response = await fetch(source.manager.resolveURL(payload));
    assert.equal(await response.text(), "selected geometry");
  } finally {
    source.dispose();
  }
});

test("LCC local environment size does not require downloading it", () => {
  const scene = localFile("scene/model.lcc");
  const environment = localFile("scene/environment.bin", new Uint8Array(96));
  const source = modelFromLocalFiles([
    scene,
    environment,
    localFile("scene/data.bin"),
  ]);
  try {
    assert.equal(
      source.manager.getFileSize(new URL("environment.bin", source.url).href),
      96,
    );
    assert.equal(
      source.manager.getFileSize(new URL("missing.bin", source.url).href),
      null,
    );
    assert.throws(
      () => source.manager.resolveURL(new URL("index.bin", source.url).href),
      /Select the companion file/,
    );
  } finally {
    source.dispose();
  }
});

test("multiple scene manifests require an explicit choice", () => {
  assert.throws(
    () => modelFromLocalFiles([localFile("a.lcc"), localFile("b.lcc2")]),
    /Choose one model/,
  );
});
