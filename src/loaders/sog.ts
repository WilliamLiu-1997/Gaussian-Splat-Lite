import { SogDecodeSession, decode_sog_meta } from "gaussian-splat-rs";
import { linkedAbortController } from "../runtime/abort";
import type { SplatSourceArgs } from "./loadTypes";
import type { PostDecodeSplatData } from "./postDecode/protocol";
import { openSogSource, readSogAsset } from "./sog/SogSource";
import { readZip } from "./sog/sogZip";
import { joinBytes as join } from "./source";

type LoadArgs = SplatSourceArgs & { expectedSogCount?: number };
function fail(message: string): never {
  throw new Error(`SOG: ${message}`);
}

function isJson(bytes: Uint8Array) {
  let index =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (index < bytes.length && [9, 10, 13, 32].includes(bytes[index]))
    index++;
  return bytes[index] === 123;
}

export function isSogPrefix(bytes: Uint8Array) {
  return (
    (bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 3 &&
      bytes[3] === 4) ||
    isJson(bytes.subarray(0, 4096))
  );
}

/** @internal Loads SOG with range reads and grouped property decoding. */
export async function loadSog(args: LoadArgs): Promise<PostDecodeSplatData> {
  const { controller, cleanup } = linkedAbortController(args.signal);
  try {
    args.signal?.throwIfAborted();
    return await decodeSog(args, controller);
  } finally {
    cleanup();
    controller.abort();
  }
}

async function decodeSog(args: LoadArgs, controller: AbortController) {
  let loaded = 0;
  let total = 0;
  let lastProgress = 0;
  const progress = (bytes: number, expectedTotal?: number) => {
    loaded += bytes;
    if (expectedTotal !== undefined) total = expectedTotal;
    // A server can hide Content-Encoding, making Content-Length an underestimate.
    if (loaded > total) total = 0;
    const now = performance.now();
    if (expectedTotal !== undefined || now - lastProgress >= 50) {
      args.sendStatus({ loaded, total });
      lastProgress = now;
    }
  };
  const source = await openSogSource(args, progress, controller.signal);
  const prefix = await source.read(0, Math.min(source.size, 4096), true);
  if (!isSogPrefix(prefix))
    fail("input is neither a ZIP archive nor SOG metadata");
  const zip = isJson(prefix) ? undefined : await readZip(source);
  const metadata = decode_sog_meta(
    zip
      ? join(await zip.read(zip.meta), zip.meta.compressedSize)
      : await source.read(0, source.size),
    zip?.meta.method ?? 0,
    zip?.meta.size ?? source.size,
    zip?.meta.crc ?? -1,
  );
  if (args.expectedSogCount !== undefined) {
    const meta = JSON.parse(metadata.replace(/^\uFEFF+/, ""));
    const count = meta.version === 2 ? meta.count : meta.means?.shape?.[0];
    if (count !== args.expectedSogCount)
      fail(
        `chunk count mismatch: expected ${args.expectedSogCount}, received ${count}`,
      );
  }
  controller.signal.throwIfAborted();
  const session = new SogDecodeSession(metadata);
  let consumed = false;
  try {
    const groups = JSON.parse(session.plan()) as string[][];
    // Metadata and bundles with external assets do not describe the total input size.
    if (!zip || groups.some((group) => group.some((name) => !zip.entry(name))))
      progress(0, 0);
    const downloadAsset = async (name: string) => {
      controller.signal.throwIfAborted();
      const entry = zip?.entry(name);
      const chunks =
        zip && entry
          ? await zip.read(entry)
          : await readSogAsset(
              name,
              args,
              source.url,
              progress,
              controller.signal,
            );
      return { entry, chunks };
    };
    // Start all property downloads: five images, plus two with higher-order SH.
    const downloads = groups.map((names) =>
      names.map((name) => {
        const task = downloadAsset(name);
        // Observe background errors immediately and cancel their sibling requests.
        void task.catch((error) => controller.abort(error));
        return task;
      }),
    );
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      try {
        const assets = await Promise.all(downloads[index]);
        downloads[index] = []; // Do not retain decoded groups through settled promises.
        const hasNextGroup = index + 1 < groups.length;
        for (const { entry, chunks } of assets) {
          // Let other downloads advance before synchronous image decoding.
          if (hasNextGroup)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          controller.signal.throwIfAborted();
          session.decode_asset(
            chunks,
            entry?.method ?? 0,
            entry?.size ?? 0,
            entry?.crc ?? -1,
          );
        }
        let lastYield = performance.now();
        while (!session.decode_batch()) {
          if (
            (hasNextGroup || args.signal) &&
            performance.now() - lastYield >= 16
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
          }
          controller.signal.throwIfAborted();
        }
      } catch (error) {
        controller.signal.throwIfAborted();
        fail(
          `${group.join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    controller.signal.throwIfAborted();
    consumed = true;
    const result = session.finish() as PostDecodeSplatData;
    progress(0, loaded);
    return result;
  } finally {
    controller.abort();
    if (!consumed) session.free();
  }
}
