// Legacy SPZ wraps its header in gzip. Stop as soon as its first 16 bytes arrive.
async function gzipHeader(file) {
  const reader = file
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const header = new Uint8Array(16);
  try {
    let offset = 0;
    while (offset < header.length) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Incomplete SPZ header");
      const part = value.subarray(0, header.length - offset);
      header.set(part, offset);
      offset += part.length;
    }
    return header;
  } finally {
    await reader.cancel();
  }
}

async function spzInfo(file) {
  let bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const gzip = bytes[0] === 31 && bytes[1] === 139;
  if (gzip) bytes = await gzipHeader(file);
  const header = new DataView(bytes.buffer);
  const version = header.getUint32(4, true);
  if (
    header.getUint32(0, true) !== 0x5053474e ||
    (gzip ? version < 1 || version > 3 : version !== 4)
  )
    throw new Error("Unknown SPZ header");
  return { count: header.getUint32(8, true), degree: header.getUint8(12) };
}

async function plyInfo(file) {
  // Bound the preview read even when a dropped file has no PLY terminator.
  for (let size = 4096; size <= 1024 ** 2; size *= 4) {
    const text = await file.slice(0, size).text();
    const end = text.search(/^end_header\r?$/m);
    if (end < 0 && size < file.size) continue;
    const header = text.slice(0, end);
    if (
      end < 0 ||
      !/^ply\r?\n/.test(header) ||
      !/^format\s+binary_little_endian\s+1\.0\s*$/m.test(header)
    )
      break;
    let count;
    let element;
    let coefficients = 0;
    for (const line of header.split("\n")) {
      const [kind, name, value] = line.trim().split(/\s+/);
      if (kind === "element") {
        if (name === "chunk")
          return {
            problem:
              "Compressed PLY is unsupported. Export an uncompressed PLY.",
          };
        element = name;
        if (name === "vertex") count = Number(value);
      } else if (
        kind === "property" &&
        element === "vertex" &&
        /^f_rest_\d+$/.test(value)
      ) {
        coefficients++;
      }
    }
    return { count, degree: [0, 9, 24, 45, 72].indexOf(coefficients) };
  }
  throw new Error("Could not read PLY header");
}

export async function sourceInfo(file) {
  try {
    const info = await (/\.ply$/i.test(file.name)
      ? plyInfo(file)
      : spzInfo(file));
    const { count, degree } = info;
    if (
      info.problem ||
      (Number.isSafeInteger(count) &&
        count > 0 &&
        count <= 0xffffffff &&
        degree >= 0 &&
        degree <= 4)
    )
      return { file, ...info };
  } catch {
    // The decoder can still read files beyond the preview's header limit.
  }
  return { file };
}
