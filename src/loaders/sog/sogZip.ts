import type { ByteSource as Source } from "../source";

type Entry = {
  name: string;
  nameLength: number;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
};

const MiB = 1024 * 1024;
const READ_CHUNK = 16 * MiB;
const utf8 = new TextDecoder("utf-8", { fatal: true });
// ZIP's original filename encoding, used when the UTF-8 flag is absent.
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function fail(message: string): never {
  throw new Error(`SOG: ${message}`);
}

function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function filename(bytes: Uint8Array, flags: number) {
  if (flags & 0x800) return utf8.decode(bytes);
  return Array.from(bytes, (byte) =>
    byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128],
  ).join("");
}

function pathName(name: string) {
  if (
    !name ||
    /[\0\\]/.test(name) ||
    name.startsWith("/") ||
    /^[a-z]+:/i.test(name)
  ) {
    fail(`invalid archive path ${name}`);
  }
  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail(`archive path escapes its root: ${name}`);
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export async function readZip(source: Source) {
  if (source.size < 22) fail("truncated ZIP archive");
  const tailOffset = Math.max(0, source.size - 65557);
  const tail = await source.read(tailOffset, source.size - tailOffset, true);
  const view = dataView(tail);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === tail.byteLength
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("ZIP end-of-directory record is missing");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count
  )
    fail("multi-disk ZIP archives are unsupported");
  if (
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)
  )
    fail("ZIP64 archives are unsupported");
  if (offset + size !== tailOffset + end) fail("invalid ZIP directory");
  const bytes = await source.read(offset, size, true);
  const directory = dataView(bytes);
  const entries = new Map<string, Entry>();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size || directory.getUint32(cursor, true) !== 0x02014b50)
      fail("invalid ZIP directory entry");
    const flags = directory.getUint16(cursor + 8, true);
    const method = directory.getUint16(cursor + 10, true);
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > size) fail("truncated ZIP directory entry");
    if (flags & 0x41) fail("encrypted ZIP entries are unsupported");
    if (method !== 0 && method !== 8)
      fail(`unsupported ZIP compression method ${method}`);
    if (directory.getUint16(cursor + 34, true))
      fail("multi-disk ZIP entries are unsupported");
    const name = filename(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      flags,
    );
    const entry: Entry = {
      name,
      nameLength,
      flags,
      method,
      crc: directory.getUint32(cursor + 16, true),
      compressedSize: directory.getUint32(cursor + 20, true),
      size: directory.getUint32(cursor + 24, true),
      offset: directory.getUint32(cursor + 42, true),
    };
    if ([entry.compressedSize, entry.size, entry.offset].includes(0xffffffff))
      fail("ZIP64 entries are unsupported");
    const extraEnd = next - commentLength;
    for (let extra = extraEnd - extraLength; extra < extraEnd; ) {
      if (extra + 4 > extraEnd) fail("truncated ZIP extra field");
      const tag = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (tag === 1) fail("ZIP64 entries are unsupported");
      extra += 4 + length;
      if (extra > extraEnd) fail("truncated ZIP extra field");
    }
    const key = pathName(name);
    if (entries.has(key)) fail(`duplicate ZIP path ${key}`);
    if (!name.endsWith("/")) entries.set(key, entry);
    cursor = next;
  }
  if (cursor !== size) fail("ZIP directory size mismatch");
  const rootMeta = entries.get("meta.json");
  const candidates = [...entries.keys()].filter(
    (name) => name.split("/").pop() === "meta.json",
  );
  if (!rootMeta && candidates.length !== 1)
    fail("ZIP must contain one unambiguous meta.json");
  const metaName = rootMeta ? "meta.json" : candidates[0];
  const meta = entries.get(metaName);
  if (!meta) fail("ZIP metadata is missing");
  const prefix = metaName.slice(0, metaName.length - "meta.json".length);
  const read = async (entry: Entry) => {
    if (entry.offset + 30 + entry.nameLength > offset)
      fail(`invalid local header for ${entry.name}`);
    // Fetch the local header and the first payload chunk together.
    const header = await source.read(
      entry.offset,
      Math.min(READ_CHUNK, 30 + entry.nameLength + entry.compressedSize),
    );
    const local = dataView(header);
    if (
      local.getUint32(0, true) !== 0x04034b50 ||
      local.getUint16(6, true) !== entry.flags ||
      local.getUint16(8, true) !== entry.method
    ) {
      fail(`local header disagrees with directory for ${entry.name}`);
    }
    const nameLength = local.getUint16(26, true);
    const extraLength = local.getUint16(28, true);
    if (nameLength !== entry.nameLength)
      fail("ZIP local filename length mismatch");
    const start = entry.offset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > offset)
      fail(`truncated payload for ${entry.name}`);
    const localName = header.subarray(30, 30 + nameLength);
    if (filename(localName, entry.flags) !== entry.name)
      fail("ZIP local filename mismatch");
    if (
      !(entry.flags & 8) &&
      (local.getUint32(14, true) !== entry.crc ||
        local.getUint32(18, true) !== entry.compressedSize ||
        local.getUint32(22, true) !== entry.size)
    )
      fail(`local payload size or CRC mismatch for ${entry.name}`);
    const first = header.subarray(start - entry.offset);
    const chunks = first.length ? [first] : [];
    for (
      let cursor = first.length;
      cursor < entry.compressedSize;
      cursor += READ_CHUNK
    ) {
      chunks.push(
        await source.read(
          start + cursor,
          Math.min(READ_CHUNK, entry.compressedSize - cursor),
        ),
      );
    }
    return chunks;
  };
  return {
    meta,
    read,
    entry(name: string) {
      if (name.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(name))
        return undefined;
      for (const path of [prefix + name, name]) {
        try {
          const entry = entries.get(pathName(path));
          if (entry) return entry;
        } catch {
          // A reference outside the archive is resolved as an external URL.
        }
      }
      return undefined;
    },
  };
}
