// Data organization formats originated from XGRIDS. The index keeps LCC Unit
// LODs as single-child chains; LCC2 retains its exported spatial branches.
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`LCC: invalid ${name}`);
  return value;
}
function vector(value, name) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  )
    throw new Error(`LCC: invalid ${name}`);
  return value;
}
function bounds(value) {
  const min = vector(value?.min, "boundingBox.min");
  const max = vector(value?.max, "boundingBox.max");
  if (min.some((v, axis) => v > max[axis]))
    throw new Error("LCC: inverted bounds");
  return [...min, ...max];
}
/** Official exporters may leave trailing commas in their JSON objects. */
export function parseLccJson(text) {
  let result = "";
  let quoted = false;
  let escaped = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "," && /^[\s]*[}\]]/.test(source.slice(i + 1))) continue;
    result += char;
  }
  return JSON.parse(result);
}
function table(format, count, levels, sceneBounds, meta) {
  if (!Number.isSafeInteger(levels) || levels < 1 || levels > 255)
    throw new Error("LCC: invalid LOD level count");
  return {
    format,
    levels,
    maxLod: levels - 1,
    numNodes: count,
    bounds: new Float64Array(count * 6),
    parents: new Int32Array(count).fill(-1),
    firstChild: new Uint32Array(count),
    childCount: new Uint32Array(count),
    level: new Uint8Array(count),
    counts: new Float64Array(count),
    chunk: new Uint32Array(count),
    start: new Float64Array(count),
    roots: [],
    chunks: [],
    sceneBounds,
    info: {
      format,
      version: meta.version,
      epsg: meta.epsg,
      offset: meta.offset,
      shift: meta.shift,
      scale: meta.scale,
      levelSplats: Array(levels).fill(0),
    },
  };
}
function quantization(meta, environment, hasSh) {
  const attributes = new Map(meta.attributes?.map((a) => [a.name, a]));
  const range = (name) => {
    const value =
      attributes.get(environment ? `env${name}` : name) ?? attributes.get(name);
    return [
      ...vector(value?.min, `${name}.min`),
      ...vector(value?.max, `${name}.max`),
    ];
  };
  return new Float32Array([
    ...range("scale"),
    ...(hasSh ? range("shcoef") : [0, 0, 0, 0, 0, 0]),
  ]);
}
/** index.bin: one XY Unit ID followed by count/uint64 offset/size per LOD. */
export function parseLccIndex(meta, bytes, baseUrl) {
  if (!["3.0", "5.0"].includes(meta.version))
    throw new Error(`LCC: unsupported version ${meta.version}`);
  if (meta.encoding !== "COMPRESS")
    throw new Error("LCC: only COMPRESS encoding is supported");
  // LCC 3.0 predates fileType; the SDK treats an omitted value as Quality.
  const fileType =
    meta.fileType ?? (meta.version === "3.0" ? "Quality" : undefined);
  if (!/^(portable|quality)$/i.test(fileType))
    throw new Error("LCC: unsupported fileType");
  const levels = integer(meta.totalLevel, "totalLevel");
  const sceneBounds = bounds(meta.boundingBox);
  const stride = 4 + levels * 16;
  if (!levels || bytes.byteLength % stride)
    throw new Error("LCC: truncated index.bin");
  const cell = [meta.cellLengthX, meta.cellLengthY];
  if (!cell.every((v) => Number.isFinite(v) && v > 0))
    throw new Error("LCC: invalid cell dimensions");
  const units = bytes.byteLength / stride;
  const index = table("lcc", units * levels, levels, sceneBounds, meta);
  index.hasSh = fileType.toLowerCase() === "quality";
  index.ranges = quantization(meta, false, index.hasSh);
  index.environmentRanges = quantization(meta, true, index.hasSh);
  index.shUrl = new URL("shcoef.bin", baseUrl).href;
  const url = new URL("data.bin", baseUrl).href;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let unit = 0; unit < units; unit++) {
    const record = unit * stride;
    const x = sceneBounds[0] + view.getInt16(record, true) * cell[0];
    const y = sceneBounds[1] + view.getInt16(record + 2, true) * cell[1];
    index.roots.push(unit * levels);
    for (let depth = 0; depth < levels; depth++) {
      const node = unit * levels + depth;
      const level = levels - depth - 1;
      const entry = record + 4 + level * 16;
      const count = view.getUint32(entry, true);
      const offset = Number(view.getBigUint64(entry + 4, true));
      const size = view.getUint32(entry + 12, true);
      integer(offset, "data offset");
      integer(offset + size, "data range end");
      if (offset % 32 || size !== count * 32)
        throw new Error("LCC: invalid node byte range");
      index.bounds.set(
        [x, y, sceneBounds[2], x + cell[0], y + cell[1], sceneBounds[5]],
        node * 6,
      );
      index.parents[node] = depth ? node - 1 : -1;
      index.firstChild[node] = level ? node + 1 : 0;
      index.childCount[node] = level ? 1 : 0;
      index.level[node] = level;
      index.counts[node] = count;
      index.chunk[node] = index.chunks.length;
      index.chunks.push({ url, offset, size, count });
      index.info.levelSplats[level] += count;
    }
  }
  index.environment = index.chunks.length;
  index.chunks.push({
    url: new URL("environment.bin", baseUrl).href,
    count: -1,
    environment: true,
  });
  return index;
}
function children(node) {
  const list = Object.values(node.child ?? {});
  if (node.childNum !== undefined && node.childNum !== list.length)
    throw new Error("LCC2: childNum does not match child entries");
  return list;
}
function limitVirtualLod(index, meta) {
  const counts = index.info.levelSplats;
  let virtual = meta.virtualLoD?.levels ?? 0;
  // Version 0.0.2 identifies its subsampled preview levels by their counts.
  if (!virtual && meta.version === "0.0.2" && counts.at(-1) < 500_000)
    for (let level = index.levels - 1; level > 0; level--) {
      if (Math.abs(counts[level - 1] - 2 * counts[level]) > 1) break;
      virtual++;
    }
  if (virtual > 0 && virtual < index.levels)
    for (let level = index.levels - virtual; level < index.levels; level++)
      if (counts[level] < 3_000_000) {
        index.maxLod = Math.max(1, level - 1);
        break;
      }
}
/** Normalize the earlier exporter schema in the same way as XGRIDS Web SDK. */
function normalize(meta) {
  if (meta.total_splats === undefined) return;
  meta.totalLevels = meta.lod_level;
  meta.root.splatFiles = meta.root.files.map(
    (path) => `${path.replace(/^\//, "").replace(/\.sog$/i, "")}.sog`,
  );
  const visit = (node) => {
    node.boundingBox = {
      min: [node.x_min, node.y_min, node.z_min],
      max: [node.x_max, node.y_max, node.z_max],
    };
    node.childNum = node.child_num;
    for (const child of children(node)) visit(child);
  };
  visit(meta.root);
}
/** Nodes reference file-order splat ranges; adjacent nodes may share one file. */
export function parseLcc2Index(meta, baseUrl) {
  if (
    meta.total_splats === undefined &&
    !["0.0.2", "0.0.3"].includes(meta.version)
  )
    throw new Error(`LCC2: unsupported version ${meta.version}`);
  normalize(meta);
  const root = meta.root;
  if (!Array.isArray(root?.splatFiles))
    throw new Error("LCC2: missing splatFiles");
  const levels = integer(meta.totalLevels, "totalLevels");
  const nodes = children(root);
  const roots = nodes.map((_, id) => id);
  const parents = nodes.map(() => -1);
  const depths = nodes.map(() => 1);
  const firsts = [];
  for (let id = 0; id < nodes.length; id++) {
    firsts.push(nodes.length);
    for (const child of children(nodes[id])) {
      nodes.push(child);
      parents.push(id);
      depths.push(depths[id] + 1);
    }
  }
  const index = table(
    "lcc2",
    nodes.length,
    levels,
    bounds(root.boundingBox),
    meta,
  );
  index.roots = roots;
  index.chunks = root.splatFiles.map((path) => {
    if (typeof path !== "string" || !path)
      throw new Error("LCC2: invalid file path");
    const type =
      /\.(sog|spz|ply)(?:[?#]|$)/i.exec(path)?.[1]?.toLowerCase() ??
      meta.splatType?.replace(/^\./, "").toLowerCase();
    if (!["sog", "spz", "ply"].includes(type))
      throw new Error("LCC2: unsupported splat type");
    // XGRIDS paths beginning with '/' are still relative to the model folder.
    return {
      url: new URL(path.replace(/^\//, ""), baseUrl).href,
      type,
      count: 0,
    };
  });
  const env = root.data?.env;
  if (env) {
    const file = integer(env.name, "environment file");
    if (!index.chunks[file])
      throw new Error("LCC2: environment file out of bounds");
    index.environment = file;
    index.chunks[file].environment = true;
    index.chunks[file].count = -1;
  }
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id];
    if (depths[id] > levels) throw new Error("LCC2: tree exceeds totalLevels");
    index.bounds.set(bounds(node.boundingBox), id * 6);
    index.parents[id] = parents[id];
    index.firstChild[id] = firsts[id];
    index.childCount[id] = children(node).length;
    const level = levels - depths[id];
    index.level[id] = level;
    const data = node.data?.["3dgs"];
    if (!data) throw new Error("LCC2: missing node 3dgs data");
    const file = integer(data.name, "file index");
    const start = integer(data.start, "start");
    const count = integer(data.count, "count");
    const end = integer(start + count, "range end");
    if (!index.chunks[file] || file === index.environment)
      throw new Error("LCC2: node file out of bounds");
    index.chunk[id] = file;
    index.start[id] = start;
    index.counts[id] = count;
    index.chunks[file].count = Math.max(index.chunks[file].count, end);
    index.info.levelSplats[level] += count;
  }
  limitVirtualLod(index, meta);
  return index;
}
