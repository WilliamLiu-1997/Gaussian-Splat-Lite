import { SplatFileType } from "gaussian-splat-lite";

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

export function modelFromLocalFiles(files) {
  const models = files.filter((entry) => fileTypeFor(entry));
  if (models.length > 1) {
    throw new Error(
      "Choose one model or metadata file together with its companion files.",
    );
  }
  const file =
    models[0] ?? files.find((entry) => !/\.(radc|webp)$/i.test(entry.name));
  if (!file) {
    throw new Error(
      "Include meta.json with SOG images, or the .rad header with RAD chunks.",
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
      [paths, normalize(entry.webkitRelativePath || entry.name)],
      [names, entry.name],
    ]) {
      const matches = map.get(key) ?? [];
      matches.push(entry);
      map.set(key, matches);
    }
  }
  const rootPath = normalize(file.webkitRelativePath || file.name);
  const directory = rootPath.slice(0, rootPath.lastIndexOf("/") + 1);
  const resolveFile = (filename, signal) => {
    signal.throwIfAborted();
    const relative = normalize(directory + filename);
    const exact = paths.get(relative) ?? paths.get(normalize(filename));
    const matches = exact ?? names.get(normalize(filename).split("/").at(-1));
    if (matches?.length === 1) return matches[0];
    if (matches?.length > 1)
      throw new Error(`Ambiguous companion filename: ${filename}`);
    throw new Error(`Select the companion file: ${filename}`);
  };
  return { file, resolveFile };
}
