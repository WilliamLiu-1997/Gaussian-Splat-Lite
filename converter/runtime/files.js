// Synchronous calls used by the existing CLI builders, confined to one job.
import { basename, dirname, join } from "@jspm/core/nodelibs/path";
import { PageStore } from "./pages.js";

const nodes = new Map([["/", { children: new Set() }]]);
const reader = new FileReaderSync();
let pages;
let output;
let serial = 0;
export const constants = { W_OK: 2, X_OK: 1 };

function add(path, node) {
  if (nodes.has(path)) throw new Error(`Output already exists: ${path}`);
  get(dirname(path)).children.add(basename(path));
  nodes.set(path, node);
  return node;
}

function get(path) {
  const node = nodes.get(path);
  if (!node)
    throw Object.assign(new Error(`File not found: ${path}`), {
      code: "ENOENT",
    });
  return node;
}

export function mount(path, input, handle, result) {
  output = result;
  pages = new PageStore(handle);
  add(path, { input, size: input.size });
}

export function metadataBytes() {
  return (pages?.length ?? 0) * 64 + nodes.size * 512;
}

export function mkdirSync(path, { recursive } = {}) {
  if (recursive && nodes.get(path)?.children) return;
  if (recursive) mkdirSync(dirname(path), { recursive });
  add(path, { children: new Set() });
}

export function mkdtempSync(prefix) {
  const path = prefix + serial++;
  mkdirSync(path);
  return path;
}

export function statSync(path, options) {
  if (options?.throwIfNoEntry === false && !nodes.has(path)) return;
  const node = get(path);
  return { size: node.size, isDirectory: () => Boolean(node.children) };
}
export { statSync as lstatSync };
export const accessSync = (path) => {
  get(path);
};
export const readdirSync = (path) => [...get(path).children];

export function openSync(path, flags) {
  const node = flags === "r" ? get(path) : add(path, { size: 0, pages: [] });
  return { node, position: 0 };
}
export const fstatSync = (fd) => ({ size: fd.node.size });
export function closeSync(fd) {
  fd.node = undefined;
}

export function readSync(
  fd,
  buffer,
  offset = 0,
  length = buffer.length,
  position = undefined,
) {
  const at = position ?? fd.position;
  const destination = buffer.subarray(offset, offset + length);
  const { node } = fd;
  let count;
  if (node.input) {
    const bytes = reader.readAsArrayBuffer(node.input.slice(at, at + length));
    destination.set(new Uint8Array(bytes));
    count = bytes.byteLength;
  } else count = pages.read(node, destination, at);
  if (position === undefined) fd.position += count;
  return count;
}

export function writeSync(fd, data, offset, length, position) {
  return pages.write(fd.node, data.subarray(offset, offset + length), position);
}
export function rmSync(path, options) {
  if (options?.force && !nodes.has(path)) return;
  const node = get(path);
  if (node.children) {
    if (node.children.size && !options?.recursive)
      throw new Error(`Directory is not empty: ${path}`);
    for (const child of node.children) rmSync(join(path, child), options);
  } else if (node.pages) pages.release(node);
  get(dirname(path)).children.delete(basename(path));
  nodes.delete(path);
}

function moveTree(from, to) {
  const node = get(from);
  nodes.delete(from);
  nodes.set(to, node);
  for (const child of node.children ?? [])
    moveTree(join(from, child), join(to, child));
}
export function renameSync(from, to) {
  if (nodes.has(to)) rmSync(to);
  moveTree(from, to);
  get(dirname(from)).children.delete(basename(from));
  get(dirname(to)).children.add(basename(to));
  // Both writers publish their entry last, after closing the output files.
  if (to === output?.entry) Atomics.store(output.published, 0, 1);
}
