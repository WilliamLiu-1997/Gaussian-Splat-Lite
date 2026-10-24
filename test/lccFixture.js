import { readLccScene } from "../src/loaders/stream/lcc-stream/lccScene.js";

const url = "https://scene.invalid/chunks/scene.lcc";
function fixture({
  counts = [1],
  offsets = counts.map(() => 0),
  unit = 0,
  fileType = "Quality",
  environmentCount = 0,
  missingEnvironmentSh = false,
} = {}) {
  const levels = counts.length;
  const metadata = {
    version: "5.0",
    encoding: "COMPRESS",
    fileType,
    totalLevel: levels,
    totalSplats: counts.reduce((sum, count) => sum + count, 0),
    splats: counts,
    indexDataSize: 4 + 16 * levels,
    cellLengthX: 2,
    cellLengthY: 2,
    boundingBox: { min: [-1, -1, -3], max: [3, 1, -1] },
    attributes: [
      { name: "scale", min: [0.01, 0.02, 0.03], max: [1, 2, 3] },
      { name: "shcoef", min: [-1, -2, -3], max: [1, 2, 3] },
      { name: "envscale", min: [10, 20, 30], max: [40, 50, 60] },
      ...(!missingEnvironmentSh
        ? [{ name: "envshcoef", min: [-4, -5, -6], max: [4, 5, 6] }]
        : []),
    ],
  };
  const index = new Uint8Array(metadata.indexDataSize);
  const view = new DataView(index.buffer);
  view.setUint32(0, unit, true);
  for (let level = 0; level < levels; level++) {
    const cursor = 4 + level * 16;
    view.setUint32(cursor, counts[level], true);
    view.setBigUint64(cursor + 4, BigInt(offsets[level]), true);
    view.setUint32(cursor + 12, counts[level] * 32, true);
  }
  const dataSize = Math.max(
    0,
    ...counts.map((count, level) => offsets[level] + count * 32),
  );
  return {
    metadata,
    index,
    dataSize,
    shSize: dataSize * 2,
    environmentSize: environmentCount * (fileType === "Quality" ? 96 : 32),
  };
}
export async function readLccFixture(context, options = {}) {
  const value = fixture(options);
  const files = new Map([
    ["index.bin", value.index.length],
    ["data.bin", value.dataSize],
    ["shcoef.bin", value.shSize],
    ["environment.bin", value.environmentSize],
  ]);
  const fetches = [];
  context.mock.method(globalThis, "fetch", async (input) => {
    const name = new URL(String(input)).pathname.split("/").at(-1);
    fetches.push(name);
    if (name === "scene.lcc")
      return new Response(JSON.stringify(value.metadata));
    if (name === "index.bin") return new Response(value.index);
    if (options.probe && files.has(name) && files.get(name) > 0)
      return new Response(new Uint8Array(1), {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-0/${files.get(name)}`,
          ETag: '"chunks-v1"',
        },
      });
    return new Response("absent", { status: 404 });
  });
  const model = await readLccScene(
    {
      url,
      manager: {
        resolveURL: (value) => value,
        itemStart() {},
        itemEnd() {},
        itemError() {},
        getFileSize(input) {
          const name = new URL(String(input)).pathname.split("/").at(-1);
          return files.has(name)
            ? options.probe && name !== "index.bin" && files.get(name) > 0
              ? undefined
              : files.get(name)
            : null;
        },
      },
    },
    new AbortController().signal,
  );
  return { model, ...value, fetches };
}
