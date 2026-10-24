const DEFAULT_LIMITS = {
  maxManifestBytes: 1024 * 1024,
  maxLevels: 32,
  maxIndexBytes: 16 * 1024 * 1024,
  maxUnits: 100000,
};
const MAX_F32 = 3.4028234663852886e38;

function fail(message) {
  throw new Error(`LCC: ${message}`);
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    fail(`${label} must be a safe integer >= ${minimum}`);
  return value;
}

function limit(options, key) {
  return integer(options[key] ?? DEFAULT_LIMITS[key], key, 1);
}

function vector(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_F32)
  )
    fail(`${label} must contain three finite float32-range numbers`);
  return value.slice();
}

function bounds(value, label) {
  if (!value || typeof value !== "object") fail(`missing ${label}`);
  const min = vector(value.min, `${label}.min`);
  const max = vector(value.max, `${label}.max`);
  if (min.some((v, i) => v > max[i])) fail(`${label} min exceeds max`);
  return { min, max };
}

function scaleRange(value, label) {
  const range = bounds(value, label);
  if (range.min.some((v) => v < 0))
    fail(`${label} must be physical, nonnegative scales`);
  return range;
}

/** Parse bounded JSON text, not an already allocated manifest object. */
export function parseLccManifest(input, options = {}) {
  const maxBytes = limit(options, "maxManifestBytes");
  let text;
  if (typeof input === "string") {
    if (
      input.length > maxBytes ||
      new TextEncoder().encode(input).length > maxBytes
    )
      fail("manifest byte limit exceeded");
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > maxBytes) fail("manifest byte limit exceeded");
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } else {
    fail("manifest must be JSON text or Uint8Array");
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    fail("invalid manifest JSON");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    fail("manifest must be an object");
  if (meta.version !== "5.0") fail(`unsupported version ${meta.version}`);
  if (meta.encoding !== "COMPRESS")
    fail(`unsupported encoding ${meta.encoding}`);
  const fileType = meta.fileType ?? options.fileType;
  if (!["Portable", "Quality"].includes(fileType))
    fail("fileType must explicitly specify Portable or Quality");
  if (options.fileType && options.fileType !== fileType)
    fail("fileType override conflicts with manifest");
  const totalLevel = integer(meta.totalLevel, "totalLevel", 1);
  if (totalLevel > limit(options, "maxLevels")) fail("level limit exceeded");
  const indexStride = 4 + 16 * totalLevel;
  if (meta.indexDataSize !== indexStride)
    fail(`unsupported indexDataSize; expected ${indexStride}`);
  const boundingBox = bounds(meta.boundingBox, "boundingBox");
  for (const key of ["cellLengthX", "cellLengthY"]) {
    if (!Number.isFinite(meta[key]) || meta[key] <= 0 || meta[key] > MAX_F32)
      fail(`${key} must be positive and finite`);
  }
  // No verified contract combines these fields; never silently move the scene.
  for (const [key, identity] of [
    ["offset", 0],
    ["shift", 0],
    ["scale", 1],
  ]) {
    if (
      meta[key] !== undefined &&
      vector(meta[key], key).some((v) => v !== identity)
    )
      fail(`unsupported non-identity global ${key}`);
  }
  if (meta.epsg !== undefined) integer(meta.epsg, "epsg");
  integer(meta.totalSplats, "totalSplats");
  if (!Array.isArray(meta.splats) || meta.splats.length !== totalLevel)
    fail("splats must contain one count per level");
  let sum = 0;
  for (const count of meta.splats)
    sum = integer(sum + integer(count, "splats count"), "splats sum");
  if (sum !== meta.totalSplats) fail("totalSplats disagrees with level counts");
  if (!Array.isArray(meta.attributes) || meta.attributes.length > 64)
    fail("attributes must be an array of at most 64 entries");
  const attributes = new Map();
  for (const attribute of meta.attributes) {
    if (
      !attribute ||
      typeof attribute.name !== "string" ||
      attributes.has(attribute.name)
    )
      fail("invalid or duplicate attribute name");
    attributes.set(attribute.name, attribute);
  }
  const scale = scaleRange(attributes.get("scale"), "scale");
  const sh =
    fileType === "Quality"
      ? bounds(attributes.get("shcoef"), "shcoef")
      : undefined;
  const environmentScale = attributes.has("envscale")
    ? scaleRange(attributes.get("envscale"), "envscale")
    : undefined;
  const environmentSh =
    fileType === "Quality" && attributes.has("envshcoef")
      ? bounds(attributes.get("envshcoef"), "envshcoef")
      : undefined;
  return {
    ...meta,
    fileType,
    boundingBox,
    indexStride,
    maxShDegree: fileType === "Quality" ? 3 : 0,
    environmentStride: fileType === "Quality" ? 96 : 32,
    scaleRange: scale,
    shRange: sh,
    environmentScaleRange: environmentScale,
    environmentShRange: environmentSh,
  };
}

function safeOffset(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail(`${label} exceeds safe addressing range`);
  return Number(value);
}

/** Index offsets remain exact until all base and SH range arithmetic is checked. */
export function parseLccIndex(input, manifest, options = {}) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array))
    fail("index must be ArrayBuffer or Uint8Array");
  if (bytes.byteLength > limit(options, "maxIndexBytes"))
    fail("index byte limit exceeded");
  const levels = integer(manifest.totalLevel, "totalLevel", 1);
  if (levels > limit(options, "maxLevels")) fail("level limit exceeded");
  const stride = 4 + 16 * levels;
  if (manifest.indexDataSize !== stride || bytes.byteLength % stride !== 0)
    fail("index length/stride mismatch");
  const unitCount = bytes.byteLength / stride;
  if (unitCount > limit(options, "maxUnits")) fail("unit limit exceeded");
  for (const key of ["dataByteLength", "shByteLength"]) {
    if (options[key] !== undefined) integer(options[key], key);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen = new Set();
  const units = [];
  const counts = Array(levels).fill(0);
  for (let unit = 0; unit < unitCount; unit++) {
    const start = unit * stride;
    const index = view.getUint32(start, true);
    if (seen.has(index)) fail(`duplicate Unit ${index}`);
    seen.add(index);
    const x = index & 0xffff;
    const y = index >>> 16;
    // shortcut: grid cells can exclude records; use scene bounds until per-Unit bounds are reliable.
    const { min, max } = manifest.boundingBox;
    const representations = [];
    for (let level = 0; level < levels; level++) {
      const cursor = start + 4 + 16 * level;
      const count = view.getUint32(cursor, true);
      const offset64 = view.getBigUint64(cursor + 4, true);
      const byteLength = view.getUint32(cursor + 12, true);
      if (byteLength !== count * 32)
        fail("count * 32 disagrees with base byte length");
      if (offset64 % 32n !== 0n) fail("base offset must be record aligned");
      const offset = safeOffset(offset64, "base offset");
      const end = safeOffset(offset64 + BigInt(byteLength), "base end");
      if (options.dataByteLength !== undefined && end > options.dataByteLength)
        fail("base range exceeds data file");
      const shOffset =
        manifest.fileType === "Quality"
          ? safeOffset(offset64 * 2n, "SH offset")
          : undefined;
      const shByteLength =
        manifest.fileType === "Quality" ? byteLength * 2 : undefined;
      if (shOffset !== undefined) {
        const shEnd = safeOffset(
          (offset64 + BigInt(byteLength)) * 2n,
          "SH end",
        );
        if (options.shByteLength !== undefined && shEnd > options.shByteLength)
          fail("SH range exceeds SH file");
      }
      counts[level] = integer(counts[level] + count, "index point count");
      representations.push({
        level,
        count,
        offset,
        byteLength,
        shOffset,
        shByteLength,
      });
    }
    units.push({ index, x, y, boundingBox: { min, max }, representations });
  }
  if (counts.some((count, level) => count !== manifest.splats[level]))
    fail("index counts disagree with manifest levels");
  return units;
}

/** Metadata for the narrow WASM decodeLcc(base, sh, JSON.stringify(context)) API. */
export function createLccDecodeContext(manifest, count, options = {}) {
  integer(count, "decode count");
  const maxPoints = integer(options.maxPoints ?? 1000000, "maxPoints", 1);
  if (count > maxPoints) fail("decode point limit exceeded");
  const environment = options.environment ?? false;
  if (typeof environment !== "boolean") fail("environment must be boolean");
  const scale = environment
    ? manifest.environmentScaleRange
    : manifest.scaleRange;
  const sh = environment ? manifest.environmentShRange : manifest.shRange;
  if (!scale) fail("missing environment scale range");
  if (manifest.fileType === "Quality" && !sh) fail("missing Quality SH range");
  return {
    version: manifest.version,
    encoding: manifest.encoding,
    fileType: manifest.fileType,
    count,
    maxPoints,
    environment,
    scaleMin: scale.min,
    scaleMax: scale.max,
    ...(sh ? { shMin: sh.min, shMax: sh.max } : {}),
  };
}
