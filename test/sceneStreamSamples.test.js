import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LoadingManager } from "three";
import { readLccScene } from "../src/loaders/stream/lcc-stream/lccScene.js";
import { readLcc2Scene } from "../src/loaders/stream/lcc2-stream/lcc2Scene.js";
import { preflightScenePayload } from "../src/loaders/stream/scene-stream/preflight.js";

const samples = [
  ["lcc", process.env.LCC_SAMPLE],
  ["lcc2", process.env.LCC2_SAMPLE],
];
// Private manifests are supplied directly; companions resolve relative to each manifest.
test(
  "real LCC/LCC2 exports normalize into source-relative streaming ranges",
  { skip: samples.every(([, file]) => !file) },
  async (context) => {
    for (const [extension, file] of samples) {
      await context.test(extension, { skip: !file }, async (context) => {
        const logical = pathToFileURL(file).href;
        const metadata = JSON.parse(await readFile(file, "utf8"));
        const manager = new LoadingManager();
        manager.setURLModifier((url) => `blob:local-${url}`);
        if (extension === "lcc") {
          manager.getFileSize = (url) => {
            try {
              const asset = new URL(url);
              const name = decodeURIComponent(asset.pathname.split("/").at(-1));
              // Match exact spelling even on case-insensitive filesystems.
              if (!readdirSync(new URL(".", asset)).includes(name)) return null;
              return statSync(asset).size;
            } catch (error) {
              if (error.code === "ENOENT") return null;
              throw error;
            }
          };
        }
        const fetched = [];
        context.mock.method(globalThis, "fetch", async (url) => {
          fetched.push(String(url));
          return new Response(
            await readFile(new URL(String(url).slice("blob:local-".length))),
          );
        });
        const options = { url: logical, manager, refinement: "leaves" };
        const model = await (extension === "lcc"
          ? readLccScene
          : readLcc2Scene)(options, new AbortController().signal);
        assert.ok(model.units.length > 0);
        assert.ok(
          model.units.every((unit) =>
            unit.representations.every((rep) =>
              rep.ranges.every((range) => range.source.url.startsWith("file:")),
            ),
          ),
          "logical source URLs must survive blob URL resolution",
        );
        if (extension === "lcc") {
          assert.equal(
            model.units.reduce(
              (sum, unit) => sum + unit.representations.at(-1).count,
              0,
            ),
            metadata.splats[0],
          );
          assert.ok(
            model.units.every(
              (unit) => unit.representations.length <= metadata.totalLevel,
            ),
          );
          assert.equal(fetched.length, 2, "only manifest and index are read");
        } else if (model.environment) {
          const environmentSource = model.environment.ranges[0].source;
          assert.equal(model.environment.count, metadata.env.splatsCount);
          assert.equal(
            environmentSource.url,
            new URL(
              metadata.root.splatFiles[metadata.root.data.env.name],
              logical,
            ).href,
          );
          const payload = await readFile(new URL(environmentSource.url));
          assert.equal(
            await preflightScenePayload(
              payload,
              environmentSource.codec,
              environmentSource.count,
            ),
            metadata.env.splatsCount,
          );
        }
      });
    }
  },
);
