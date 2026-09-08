import { SplatFileType } from "gaussian-splat-lite";
import { LoadingManager } from "three";

const droppedPaths = new WeakMap();

function localPath(file) {
  return droppedPaths.get(file) || file.webkitRelativePath || file.name;
}

// DataTransfer entries must be captured while the drop event is still active.
export async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer?.items ?? []);
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry: item.webkitGetAsEntry?.(),
      file: item.getAsFile(),
    }));
  const fallback = Array.from(dataTransfer?.files ?? []);
  async function readEntry(entry, parent = "") {
    const path = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) =>
        entry.file(resolve, reject),
      );
      droppedPaths.set(file, path);
      return [file];
    }
    if (!entry.isDirectory) return [];
    const reader = entry.createReader();
    const children = [];
    for (;;) {
      const batch = await new Promise((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) break;
      children.push(...batch);
    }
    return (
      await Promise.all(children.map((child) => readEntry(child, `${path}/`)))
    ).flat();
  }
  if (!entries.length) return fallback;
  return (
    await Promise.all(
      entries.map(({ entry, file }) =>
        entry ? readEntry(entry) : file ? [file] : [],
      ),
    )
  ).flat();
}

export function fileTypeFor(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".ply")) return SplatFileType.PLY;
  if (name.endsWith(".spz")) return SplatFileType.SPZ;
  if (name.endsWith(".sog") || name === "meta.json") return SplatFileType.SOG;
  if (name.endsWith(".rad")) return SplatFileType.RAD;
  return undefined;
}

export async function detectFileType(file, url) {
  const fileType = fileTypeFor(file);
  if (fileType || url || !(file instanceof Blob)) return fileType;
  const prefix = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return String.fromCharCode(...prefix) === "RAD0"
    ? SplatFileType.RAD
    : undefined;
}

export function modelFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const encodedName = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let name = encodedName;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    // Keep the encoded path segment when it contains malformed escape sequences.
  }

  return { name: name || "model", size: 0, url };
}

export function modelFromLocalFiles(selectedFiles) {
  const files = selectedFiles.filter(
    (entry) =>
      !localPath(entry)
        .split("/")
        .some((part) => part.startsWith(".")),
  );
  const indexes = files.filter(
    (entry) => entry.name.toLowerCase() === "lod-meta.json",
  );
  const models = indexes.length
    ? indexes
    : files.filter((entry) => fileTypeFor(entry));
  if (models.length > 1) {
    throw new Error(
      "Choose one model or metadata file together with its companion files.",
    );
  }
  const file =
    models[0] ?? files.find((entry) => !/\.(radc|webp)$/i.test(entry.name));
  if (!file) {
    throw new Error(
      "Include lod-meta.json with SOG chunks, meta.json with SOG images, or the .rad header with RAD chunks.",
    );
  }
  const normalize = (path) => {
    const parts = [];
    for (const part of path.replaceAll("\\", "/").split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  };
  const paths = new Map();
  const names = new Map();
  for (const entry of files) {
    for (const [map, key] of [
      [paths, normalize(localPath(entry))],
      [names, entry.name],
    ]) {
      const matches = map.get(key) ?? [];
      matches.push(entry);
      map.set(key, matches);
    }
  }
  const rootPath = normalize(localPath(file));
  const directory = rootPath.slice(0, rootPath.lastIndexOf("/") + 1);
  const findFile = (filename, base = directory) => {
    const relative = normalize(base + filename);
    const exact = paths.get(relative) ?? paths.get(normalize(filename));
    const matches = exact ?? names.get(normalize(filename).split("/").at(-1));
    if (matches?.length === 1) return matches[0];
    if (matches?.length > 1)
      throw new Error(`Ambiguous companion filename: ${filename}`);
    throw new Error(`Select the companion file: ${filename}`);
  };
  const resolveFile = (filename, signal) => {
    signal.throwIfAborted();
    return findFile(filename);
  };
  if (indexes.length) {
    // Keep hierarchical URLs for relative chunk/image references. The manager
    // maps them to local blobs only at fetch time, including inside workers.
    const baseUrl = "https://local-sog.invalid/";
    const url = new URL(
      rootPath.split("/").map(encodeURIComponent).join("/"),
      baseUrl,
    ).href;
    const blobs = new Map();
    let disposed = false;
    const manager = new LoadingManager();
    manager.setURLModifier((value) => {
      if (disposed) throw new Error("Local SOG source has been disposed");
      const asset = new URL(value, url);
      if (asset.origin !== new URL(baseUrl).origin)
        throw new Error(`Select the companion file: ${value}`);
      const companion = findFile(decodeURIComponent(asset.pathname), "");
      let blob = blobs.get(companion);
      if (!blob) {
        blob = URL.createObjectURL(companion);
        blobs.set(companion, blob);
      }
      return blob;
    });
    return {
      file,
      url,
      manager,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const blob of blobs.values()) URL.revokeObjectURL(blob);
        blobs.clear();
      },
    };
  }
  return { file, resolveFile };
}
