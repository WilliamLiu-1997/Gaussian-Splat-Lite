import { readZipDirectory } from "../../src/loaders/sog/sogZip.js";

export async function* filesInArchive(file, checkActive) {
  const { entries, storedOffset } = await readZipDirectory({
    size: file.size,
    async read(offset, length) {
      checkActive();
      const bytes = await file.slice(offset, offset + length).arrayBuffer();
      checkActive();
      return new Uint8Array(bytes);
    },
  });
  for (const [path, entry] of entries) {
    const start = await storedOffset(entry);
    yield {
      path,
      file: new File(
        [file.slice(start, start + entry.size)],
        path.split("/").at(-1),
      ),
    };
  }
}
