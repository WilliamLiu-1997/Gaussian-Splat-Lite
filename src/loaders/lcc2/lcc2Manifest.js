const DEFAULT_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxNodes: 100000,
  maxDepth: 128,
};
const encoder = new TextEncoder();

function fail(message) {
  throw new Error(`Invalid LCC2 manifest: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a nonnegative safe integer`);
  return value;
}

function limits(options) {
  const result = { ...DEFAULT_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    integer(result[key], key);
    if (key !== "maxDepth" && result[key] === 0)
      fail(`${key} must be positive`);
  }
  return result;
}

// Walk JSON iteratively, including unknown metadata, before allocating the index.
function checkJson(value, maxBytes) {
  let bytes = 0;
  const active = new WeakSet();
  const stack = [];
  const add = (count) => {
    bytes += count;
    if (bytes > maxBytes) fail("maxBytes exceeded");
  };
  const string = (value) => {
    if (value.length > maxBytes - bytes) fail("maxBytes exceeded");
    add(encoder.encode(JSON.stringify(value)).byteLength);
  };
  const visit = (value) => {
    if (value === null) return add(4);
    if (typeof value === "string") return string(value);
    if (typeof value === "boolean") return add(value ? 4 : 5);
    if (typeof value === "number" && Number.isFinite(value))
      return add(String(value).length);
    if (typeof value !== "object") fail("expected finite JSON values");
    if (active.has(value)) fail("cyclic JSON value");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      fail("expected plain JSON objects");
    const keys = array ? undefined : Object.keys(value);
    const length = array ? value.length : keys.length;
    if (length > maxBytes - bytes) fail("maxBytes exceeded");
    add(2 + Math.max(0, length - 1));
    active.add(value);
    stack.push({ value, keys, length, index: 0 });
  };
  visit(value);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.length) {
      active.delete(frame.value);
      stack.pop();
      continue;
    }
    const key = frame.keys ? frame.keys[frame.index++] : frame.index++;
    if (frame.keys) {
      string(key);
      add(1);
    }
    visit(frame.value[key]);
  }
}

function vector(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  )
    fail(`${label} must contain three finite numbers`);
  return value.slice();
}

function bounds(value, label) {
  const box = object(value, label);
  const min = vector(box.min, `${label}.min`);
  const max = vector(box.max, `${label}.max`);
  if (min.some((component, index) => component > max[index]))
    fail(`${label} min exceeds max`);
  return { min, max };
}

function resolveFile(path, baseUrl, kind) {
  if (typeof path !== "string" || !path.trim() || /\p{Cc}/u.test(path))
    fail("file path must be a nonempty string without control characters");
  let url;
  try {
    url = new URL(path, baseUrl);
  } catch {
    fail(`cannot resolve file path ${path}`);
  }
  if (!["http:", "https:", "file:"].includes(url.protocol))
    fail(`unsupported file URL protocol ${url.protocol}`);
  const codec = url.pathname.split(".").pop().toLowerCase();
  const supported =
    kind === "3dgs"
      ? ["ply", "spz", "sog"]
      : [kind === "mesh" ? "ply" : "btree"];
  if (!supported.includes(codec)) fail(`unsupported ${kind} codec ${codec}`);
  return { url: url.href, codec };
}

/** Normalize the 0.0.3 profile without applying reserved transforms or LOD policy. */
export function parseLcc2Manifest(value, baseUrl, options) {
  const budget = limits(options);
  checkJson(value, budget.maxBytes);
  const metadata = object(value, "manifest");
  if (metadata.version !== "0.0.3")
    fail(`unsupported version ${metadata.version}`);
  if (![".ply", ".spz", ".sog"].includes(metadata.splatType))
    fail(`unsupported splatType ${metadata.splatType}`);
  const totalLevels = integer(metadata.totalLevels, "totalLevels");
  if (!totalLevels) fail("totalLevels must be positive");
  const totalSplats = integer(metadata.totalSplats, "totalSplats");
  if (
    !Array.isArray(metadata.lodSplats) ||
    metadata.lodSplats.length !== totalLevels
  )
    fail("lodSplats must contain totalLevels counts");
  const lodSplats = metadata.lodSplats.map((count) =>
    integer(count, "lodSplats count"),
  );
  for (const key of ["offset", "shift", "scale"]) {
    if (metadata[key] !== undefined) vector(metadata[key], key);
  }
  const root = object(metadata.root, "root");
  const files = [];
  const tables = {};
  for (const [kind, key] of [
    ["3dgs", "splatFiles"],
    ["mesh", "meshFiles"],
    ["bvh", "bvhFiles"],
  ]) {
    const paths = root[key] ?? (kind === "3dgs" ? undefined : []);
    if (!Array.isArray(paths)) fail(`${key} must be an array`);
    tables[kind] = paths.map((path, index) => {
      const resolved = resolveFile(path, baseUrl, kind);
      if (kind === "3dgs" && `.${resolved.codec}` !== metadata.splatType)
        fail("splatFiles codec does not match splatType");
      const id = files.length;
      files.push({ id, kind, index, path, ...resolved });
      return id;
    });
  }

  const nodes = [];
  const references = [];
  const ids = new Set();
  let environmentReference;
  const parseData = (data, node, dataIndex) => {
    object(data, `node ${node.id} data`);
    const result = [];
    for (const kind of ["3dgs", "mesh", "bvh", "env"]) {
      if (!Object.hasOwn(data, kind)) continue;
      const source = object(data[kind], `${kind} reference`);
      const index = integer(source.name, `${kind} file index`);
      const table = tables[kind === "env" ? "3dgs" : kind];
      if (index >= table.length) fail(`${kind} file index out of bounds`);
      const reference = {
        kind,
        node: node.id,
        file: table[index],
        dataIndex,
        metadata: source,
      };
      if (kind === "3dgs") {
        reference.start = integer(source.start, "range start");
        reference.count = integer(source.count, "range count");
        integer(reference.start + reference.count, "range end");
      } else if (kind === "mesh") {
        reference.vertex = integer(source.vertex, "mesh vertex count");
        reference.face = integer(source.face, "mesh face count");
      } else if (kind === "env") {
        if (node.metadata !== root || environmentReference)
          fail("env reference must occur once on root");
        environmentReference = reference;
      }
      references.push(reference);
      result.push(reference);
    }
    return result;
  };
  const makeNode = (source, depth) => {
    if (depth > budget.maxDepth) fail("maxDepth exceeded");
    if (nodes.length >= budget.maxNodes) fail("maxNodes exceeded");
    object(source, "node");
    if (typeof source.id !== "string" || !source.id.trim())
      fail("node id must be a nonempty string");
    if (ids.has(source.id)) fail(`duplicate node id ${source.id}`);
    ids.add(source.id);
    const node = {
      id: source.id,
      depth,
      boundingBox: bounds(source.boundingBox, `node ${source.id} boundingBox`),
      children: [],
      data: source.data,
      references: [],
      lods: [],
      metadata: source,
    };
    nodes.push(node);
    if (Array.isArray(source.data)) {
      for (const [level, data] of source.data.entries()) {
        const refs = parseData(data, node, level);
        node.lods.push({ level, data, references: refs });
        node.references.push(...refs);
      }
    } else if (source.data != null) {
      node.references = parseData(source.data, node, undefined);
    }
    return node;
  };
  const tree = makeNode(root, 0);
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    const source = node.metadata;
    const count = integer(source.childNum, `node ${node.id} childNum`);
    let children = [];
    if (source.child !== undefined) {
      if (!Array.isArray(source.child))
        object(source.child, "child collection");
      children = Object.values(source.child);
    }
    if (children.length !== count) fail(`node ${node.id} childNum mismatch`);
    if (children.length > budget.maxNodes - nodes.length)
      fail("maxNodes exceeded");
    node.children = children.map((child) => makeNode(child, node.depth + 1));
    for (let index = node.children.length - 1; index >= 0; index--)
      pending.push(node.children[index]);
  }

  let environment;
  if (metadata.env != null || environmentReference) {
    const source = metadata.env;
    environment = { reference: environmentReference, metadata: source };
    if (source != null) {
      object(source, "env");
      if (source.type !== "splats") fail(`unsupported env type ${source.type}`);
      environment.count = integer(source.splatsCount, "env splatsCount");
      environment.boundingBox = bounds(source.boundingBox, "env boundingBox");
    }
  }
  return {
    version: "0.0.3",
    files,
    tree,
    nodes,
    references,
    environment,
    totalLevels,
    totalSplats,
    lodSplats,
    metadata,
  };
}

/** Check the byte budget before decoding UTF-8 or parsing JSON. */
export function parseLcc2Bytes(value, baseUrl, options) {
  const budget = limits(options);
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value))
    fail("bytes must be an ArrayBuffer or view");
  if (value.byteLength > budget.maxBytes) fail("maxBytes exceeded");
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let metadata;
  try {
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    fail("invalid UTF-8 JSON");
  }
  return parseLcc2Manifest(metadata, baseUrl, budget);
}
