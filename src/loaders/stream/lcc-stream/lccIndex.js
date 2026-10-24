// LCC and LCC2 scenes share one node table: each node is a block of Splats at
// one LOD level, and refining a node replaces it with all of its children. An
// LCC Unit is a chain from its coarsest level down to LOD0; an LCC2 tree is
// used as stored. Data organization formats originated from XGRIDS.
const LCC_RECORD_BYTES = 32;
const LCC_LEVEL_BYTES = 16;
const SPLAT_TYPES = ["sog", "spz", "ply"];
function fail(format, message) {
  throw new Error(`${format === "lcc2" ? "LCC2" : "LCC"}: ${message}`);
}
function object(value, format, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(format, `${name} must be an object`);
  return value;
}
function integer(value, format, name) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail(format, `${name} must be a nonnegative integer`);
  return value;
}
function vector(value, format, name) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((component) => Number.isFinite(component))
  )
    fail(format, `${name} must contain three finite numbers`);
  return value;
}
function box(value, format, name) {
  const bounds = object(value, format, name);
  const min = vector(bounds.min, format, `${name}.min`);
  const max = vector(bounds.max, format, `${name}.max`);
  if (min.some((component, axis) => component > max[axis]))
    fail(format, `${name} min exceeds max`);
  return [...min, ...max];
}
function optionalVector(value) {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => Number.isFinite(component))
    ? value.slice()
    : undefined;
}
/** LCC2 manifests have a root object; meta.lcc describes a Unit grid. */
export function isLcc2Manifest(json) {
  return (
    !!json &&
    typeof json === "object" &&
    !!json.root &&
    typeof json.root === "object"
  );
}
/** Some LCC2 exporters write trailing commas; retry without them outside strings. */
export function parseLccJson(text) {
  const source = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(source);
  } catch (error) {
    let result = "";
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === ",") {
        const next = /\S/.exec(source.slice(index + 1))?.[0];
        if (next === "}" || next === "]") continue;
      }
      result += char;
    }
    try {
      return JSON.parse(result);
    } catch {
      throw error;
    }
  }
}
function createTable(format, count) {
  return {
    format,
    nodeCount: count,
    count: new Float64Array(count),
    level: new Uint8Array(count),
    parent: new Int32Array(count),
    firstChild: new Uint32Array(count),
    childCount: new Uint32Array(count),
    // LCC: data.bin byte offset. LCC2: index into the splat files.
    location: new Float64Array(count),
    // First source ID: the record index in data.bin, or the start in an LCC2 file.
    start: new Float64Array(count),
    // Min/max XYZ per node for distance, and conservative bounds for culling.
    bounds: new Float64Array(count * 6),
    cullBounds: new Float64Array(count * 6),
  };
}
function ranges(min, max, shMin, shMax) {
  return Float32Array.from([...min, ...max, ...shMin, ...shMax]);
}
/** Validates meta.lcc; Unit layout and counts come from index.bin. */
export function parseLccMeta(json) {
  const meta = object(json, "lcc", "meta.lcc");
  const levels = integer(meta.totalLevel, "lcc", "totalLevel");
  if (levels < 1 || levels > 255)
    fail("lcc", "totalLevel must be between 1 and 255");
  if (
    meta.encoding !== undefined &&
    String(meta.encoding).toUpperCase() !== "COMPRESS"
  )
    fail("lcc", `unsupported encoding ${meta.encoding}`);
  const cell = [meta.cellLengthX, meta.cellLengthY];
  if (!cell.every((length) => Number.isFinite(length) && length > 0))
    fail("lcc", "cellLengthX and cellLengthY must be positive");
  const bounds = box(meta.boundingBox, "lcc", "boundingBox");
  if (!Array.isArray(meta.attributes))
    fail("lcc", "attributes must be an array");
  const attributes = new Map();
  for (const attribute of meta.attributes)
    if (attribute && typeof attribute.name === "string")
      attributes.set(attribute.name, attribute);
  const fileType = String(meta.fileType ?? "").toLowerCase();
  // Some exports omit fileType; follow splat-transform and use the shcoef range.
  const hasSh =
    fileType === "quality" ||
    (fileType !== "portable" && attributes.has("shcoef"));
  const range = (name, fallback) => {
    const attribute = attributes.get(name) ?? attributes.get(fallback);
    if (!attribute) fail("lcc", `missing ${name} attribute`);
    return [
      vector(attribute.min, "lcc", `${name}.min`),
      vector(attribute.max, "lcc", `${name}.max`),
    ];
  };
  const scale = range("scale");
  const sh = hasSh ? range("shcoef") : [scale[0].map(() => 0), [0, 0, 0]];
  const environmentScale = range("envscale", "scale");
  const environmentSh = hasSh ? range("envshcoef", "shcoef") : sh;
  if (
    meta.splats !== undefined &&
    (!Array.isArray(meta.splats) || meta.splats.length !== levels)
  )
    fail("lcc", "splats must list one count per level");
  return {
    levels,
    cell,
    bounds,
    hasSh,
    ranges: ranges(...scale, ...sh),
    environmentRanges: ranges(...environmentScale, ...environmentSh),
    levelSplats: meta.splats?.slice(),
    info: {
      format: "lcc",
      version: meta.version === undefined ? undefined : String(meta.version),
      levelSplats: meta.splats?.slice() ?? [],
      epsg: Number.isFinite(meta.epsg) ? meta.epsg : undefined,
      offset: optionalVector(meta.offset),
      shift: optionalVector(meta.shift),
      scale: optionalVector(meta.scale),
    },
  };
}
/** One chain per Unit: node `unit * levels` is its coarsest level, LOD0 is last. */
export function packLccIndex(meta, bytes) {
  const { levels, cell, bounds } = meta;
  const stride = 4 + LCC_LEVEL_BYTES * levels;
  if (bytes.byteLength % stride !== 0)
    fail("lcc", "index.bin length is not a whole number of Units");
  const units = bytes.byteLength / stride;
  const table = createTable("lcc", units * levels);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levelSplats = new Array(levels).fill(0);
  // Units overlap their neighbours by a narrow band of duplicated records, and
  // Gaussians extend past their centers. Culling allows for both.
  const margin = Math.max(cell[0], cell[1]) * 0.1;
  table.roots = new Uint32Array(units);
  for (let unit = 0; unit < units; unit++) {
    const record = unit * stride;
    const index = view.getUint32(record, true);
    const x = bounds[0] + (index & 0xffff) * cell[0];
    const y = bounds[1] + (index >>> 16) * cell[1];
    const cellBox = [x, y, bounds[2], x + cell[0], y + cell[1], bounds[5]];
    table.roots[unit] = unit * levels;
    for (let depth = 0; depth < levels; depth++) {
      const level = levels - 1 - depth;
      const node = unit * levels + depth;
      const entry = record + 4 + level * LCC_LEVEL_BYTES;
      const count = view.getUint32(entry, true);
      const high = view.getUint32(entry + 8, true);
      const offset = high * 2 ** 32 + view.getUint32(entry + 4, true);
      const size = view.getUint32(entry + 12, true);
      if (high >= 2 ** 21 || offset % LCC_RECORD_BYTES !== 0)
        fail("lcc", "invalid data.bin offset in index.bin");
      if (size < count * LCC_RECORD_BYTES)
        fail("lcc", "index.bin size is smaller than its splat count");
      table.count[node] = count;
      table.level[node] = level;
      table.parent[node] = depth ? node - 1 : -1;
      table.firstChild[node] = level ? node + 1 : 0;
      table.childCount[node] = level ? 1 : 0;
      table.location[node] = offset;
      table.start[node] = offset / LCC_RECORD_BYTES;
      for (let axis = 0; axis < 6; axis++) {
        table.bounds[node * 6 + axis] = cellBox[axis];
        table.cullBounds[node * 6 + axis] =
          cellBox[axis] + (axis < 3 ? -margin : margin);
      }
      levelSplats[level] += count;
    }
  }
  if (meta.levelSplats?.some((count, level) => count !== levelSplats[level]))
    fail("lcc", "index.bin splat counts do not match meta.lcc");
  table.levels = levels;
  table.sceneBounds = Float64Array.from(bounds);
  table.info = { ...meta.info, levelSplats };
  return table;
}
function children(node) {
  const child = node.child;
  if (child === null || child === undefined) return [];
  return Array.isArray(child) ? child : Object.values(child);
}
function splatType(path, fallback) {
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(path)?.[1]?.toLowerCase();
  return SPLAT_TYPES.includes(extension) ? extension : fallback;
}
/** Earlier LCC2 writers used other field names; map them like splat-transform. */
function normalizeLcc2(json) {
  if (
    json.total_splats === undefined ||
    json.lod_3dgs_info === undefined ||
    json.lod_level === undefined
  )
    return json;
  const rename = (node) => {
    if (node.childNum === undefined && node.child_num !== undefined)
      node.childNum = node.child_num;
    for (const child of children(node)) rename(child);
  };
  rename(json.root);
  json.root.splatFiles ??= (json.root.files ?? []).map((file) => {
    const path = String(file).replace(/^\/+/, "");
    return path.endsWith(".sog") ? path : `${path}.sog`;
  });
  return {
    ...json,
    totalSplats: json.total_splats,
    lodSplats: Array.isArray(json.lod_3dgs_info)
      ? [...json.lod_3dgs_info].reverse()
      : json.lod_3dgs_info,
    totalLevels: json.lod_level,
  };
}
/** Breadth-first node order keeps each node's children contiguous. */
export function packLcc2Index(json, baseUrl) {
  const meta = normalizeLcc2(object(json, "lcc2", "manifest"));
  const root = object(meta.root, "lcc2", "root");
  const levels = integer(meta.totalLevels, "lcc2", "totalLevels");
  if (levels < 1 || levels > 255)
    fail("lcc2", "totalLevels must be between 1 and 255");
  if (!Array.isArray(root.splatFiles))
    fail("lcc2", "root.splatFiles must be an array");
  const fallbackType = String(meta.splatType ?? ".sog")
    .replace(/^\./, "")
    .toLowerCase();
  const files = root.splatFiles.map((path) => {
    if (typeof path !== "string" || !path)
      fail("lcc2", "splat file paths must be nonempty strings");
    const type = splatType(path, fallbackType);
    if (!SPLAT_TYPES.includes(type))
      fail("lcc2", `unsupported splat file type ${type}`);
    return { url: new URL(path, baseUrl).href, type, required: 0 };
  });
  const environmentFile =
    root.data?.env?.name === undefined
      ? undefined
      : integer(root.data.env.name, "lcc2", "root.data.env.name");
  if (environmentFile !== undefined && environmentFile >= files.length)
    fail("lcc2", "environment file index is out of range");
  const nodes = children(root);
  const parents = new Array(nodes.length).fill(-1);
  const depths = new Array(nodes.length).fill(1);
  const firsts = [];
  for (let head = 0; head < nodes.length; head++) {
    firsts[head] = nodes.length;
    for (const child of children(object(nodes[head], "lcc2", "node"))) {
      nodes.push(child);
      parents.push(head);
      depths.push(depths[head] + 1);
    }
  }
  const table = createTable("lcc2", nodes.length);
  const sceneBounds = Array.isArray(root.boundingBox?.min)
    ? box(root.boundingBox, "lcc2", "root.boundingBox")
    : undefined;
  const levelSplats = new Array(levels).fill(0);
  const roots = [];
  for (let node = 0; node < nodes.length; node++) {
    const source = nodes[node];
    const parent = parents[node];
    if (parent < 0) roots.push(node);
    table.parent[node] = parent;
    table.firstChild[node] = firsts[node];
    table.childCount[node] = children(source).length;
    const level = Math.max(0, levels - depths[node]);
    table.level[node] = level;
    let bounds;
    if (source.boundingBox !== undefined && source.boundingBox !== null)
      bounds = box(source.boundingBox, "lcc2", `node ${source.id} boundingBox`);
    else if (parent >= 0)
      bounds = Array.from(table.bounds.subarray(parent * 6, parent * 6 + 6));
    else if (sceneBounds) bounds = sceneBounds;
    else fail("lcc2", `node ${source.id} has no boundingBox`);
    table.bounds.set(bounds, node * 6);
    table.cullBounds.set(bounds, node * 6);
    const data = source.data?.["3dgs"];
    table.location[node] = -1;
    if (data === undefined || data === null) continue;
    const file = integer(data.name, "lcc2", "3dgs.name");
    const start = integer(data.start ?? 0, "lcc2", "3dgs.start");
    const count = integer(data.count, "lcc2", "3dgs.count");
    if (file >= files.length || file === environmentFile)
      fail("lcc2", "3dgs file index is out of range");
    files[file].required = Math.max(files[file].required, start + count);
    table.count[node] = count;
    table.location[node] = file;
    table.start[node] = start;
    levelSplats[level] += count;
  }
  table.roots = Uint32Array.from(roots);
  table.levels = levels;
  table.files = files;
  table.environmentFile = environmentFile;
  table.environmentCount = Number.isSafeInteger(meta.env?.splatsCount)
    ? meta.env.splatsCount
    : undefined;
  let bounds = sceneBounds;
  if (!bounds) {
    bounds = [
      ...new Array(3).fill(Number.POSITIVE_INFINITY),
      ...new Array(3).fill(Number.NEGATIVE_INFINITY),
    ];
    for (const node of roots)
      for (let axis = 0; axis < 3; axis++) {
        bounds[axis] = Math.min(bounds[axis], table.bounds[node * 6 + axis]);
        bounds[axis + 3] = Math.max(
          bounds[axis + 3],
          table.bounds[node * 6 + axis + 3],
        );
      }
  }
  table.sceneBounds = Float64Array.from(bounds);
  table.info = {
    format: "lcc2",
    version: meta.version === undefined ? undefined : String(meta.version),
    levelSplats: Array.isArray(meta.lodSplats)
      ? meta.lodSplats.slice()
      : levelSplats,
    epsg: Number.isFinite(meta.epsg) ? meta.epsg : undefined,
    offset: optionalVector(meta.offset),
    shift: optionalVector(meta.shift),
    scale: optionalVector(meta.scale),
  };
  return table;
}
