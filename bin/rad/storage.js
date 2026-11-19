import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { Progress } from "./progress.js";
import { PAGE_BYTES, Spill } from "./spill.js";
import { Writeback } from "./writeback.js";

export { PAGE_BYTES, readAll } from "./spill.js";
export const GIB = 1024 ** 3;
// Memory the budget keeps for growth between measurements.
const MARGIN = 64 * 1024 ** 2;
// Copied over new pages: fill(0) writes shared memory a byte at a time.
const ZERO = new Uint8Array(PAGE_BYTES);

// gc() on this thread and on worker threads started later: arenas that the
// cache releases, and garbage holding buffers, return their memory to the
// system only once collected.
v8.setFlagsFromString("--expose-gc");
globalThis.gc ??= runInNewContext("gc");
// Collects twice: a collection frees the memory of what the one before found.
export function collect() {
  globalThis.gc();
  globalThis.gc();
}

// Shared memory of at least `bytes`, as WebAssembly memory like the arenas
// below: it returns to the system once collected on every platform.
export function sharedBuffer(bytes) {
  const pages = Math.ceil(bytes / PAGE_BYTES);
  return new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
    shared: true,
  }).buffer;
}

// All large arrays consist of 64 KiB pages. Neither one ArrayBuffer nor one
// WebAssembly memory has to hold the model, even with a 16+ GiB budget. Pages
// live in arenas of shared WebAssembly memory: worker threads can read the
// pages of shared arrays (see PagedArray.share() and SharedColumn), and an
// arena the cache releases returns its memory to the system once collected,
// which a SharedArrayBuffer does not on every platform. The cache takes what
// the budget leaves after the rest of the process, measured as it runs.
export class Workspace {
  constructor(
    budget,
    sync,
    parent = tmpdir(),
    cancelled = null,
    prefix = "gsl-build-rad-",
  ) {
    this.budget = budget;
    this.parent = parent;
    this.prefix = prefix;
    this.cancelled = cancelled;
    this.accesses = 0;
    this.directory = undefined;
    // Pages per arena, for at most about 256 arenas: each reserves 8 GiB of
    // address space.
    this.arenaPages = Math.max(256, Math.ceil(budget / 256 / PAGE_BYTES));
    this.arenaBytes = this.arenaPages * PAGE_BYTES;
    // The most memory the rest of the process has taken, and what it takes
    // with the threads about to start; see measure() and expect().
    this.outside = 0;
    this.floor = 0;
    this.allocations = 0;
    // Makes worker threads drop and collect their views of released arenas;
    // see Pool.collect().
    this.collector = undefined;
    this.finishSearch = undefined;
    this.used = 0;
    this.clock = 0;
    this.slots = [];
    this.free = [];
    this.rest([]);
    this.arenas = [];
    // Each slot's page object and views, kept so that loading a page
    // allocates nothing: their garbage would read as memory of the process
    // and take room from the cache.
    this.reuse = [];
    // `version` is bumped when the arenas or a shared array's directory
    // change, `generation` when the arenas change.
    this.version = 0;
    this.generation = 0;
    this.files = new Map();
    this.nextFile = 0;
    this.diskVersion = 0;
    this.readBytes = 0;
    this.writeBytes = 0;
    // File writes can remain in the system's cache after writeSync returns.
    // Reserve room for pending writeback inside the budget on every platform.
    this.writeback = new Writeback(64 * 1024 ** 2, sync, () => this.check());
    // An earlier conversion's arenas return once collected.
    this.settle();
  }

  check() {
    if (this.cancelled && Atomics.load(this.cancelled, 0))
      throw new Error("Conversion cancelled");
  }

  // Bytes all cached pages may take, at least one arena.
  get capacity() {
    return Math.max(
      this.arenaBytes,
      this.budget -
        MARGIN -
        this.writeback.limit -
        Math.max(this.outside, this.floor),
    );
  }

  // Bytes the rest of the process may still grow by.
  get room() {
    return (
      this.budget -
      MARGIN -
      this.writeback.limit -
      this.arenaBytes -
      this.outside
    );
  }

  // Rebalance the cache every 64 allocations and between streaming passes.
  adjust() {
    this.measure();
    this.shrink();
  }

  // Measures the memory of the rest of the process: all of it but the
  // arenas' pages that the cache has used.
  measure() {
    this.outside = Math.max(
      this.outside,
      process.memoryUsage.rss() - this.slots.length * PAGE_BYTES,
    );
  }

  // Measures the rest of the process anew once its garbage is collected, as
  // a phase starts.
  settle() {
    collect();
    this.outside = process.memoryUsage.rss() - this.slots.length * PAGE_BYTES;
  }

  // Makes room for `bytes` that the process is about to take besides the
  // cache. `floor` includes earlier reservations that measured growth uses
  // up, rather than adding them to that growth again.
  expect(bytes, floor = 0) {
    this.measure();
    this.floor = Math.max(this.outside, floor) + bytes;
    if (
      this.budget - MARGIN - this.writeback.limit - this.floor <
      this.arenaBytes
    )
      throw new Error("Memory budget too small; increase --memory-budget");
    this.shrink();
  }

  // Once the arenas' used pages take more than the capacity, releases the
  // arenas past it, evicting their pages, and collects them so that their
  // memory returns. Searches must release their views before arenas move.
  shrink() {
    if (this.slots.length * PAGE_BYTES <= this.capacity) return;
    this.finishSearch?.();
    const slots = Math.floor(this.capacity / this.arenaBytes) * this.arenaPages;
    // Without a copy of the slots: a copy kept the released pages alive
    // through the collection below, and their memory returned only later.
    for (let slot = slots; slot < this.slots.length; slot++)
      if (this.slots[slot]) this.drop(this.slots[slot]);
    this.slots.length = slots;
    this.reuse.length = slots;
    this.free = this.free.filter((slot) => slot < slots);
    this.arenas.length = slots / this.arenaPages;
    this.version++;
    this.generation++;
    this.collector?.();
    collect();
  }

  file() {
    if (!this.directory) {
      mkdirSync(this.parent, { recursive: true });
      this.directory = mkdtempSync(join(this.parent, this.prefix));
      console.log(`Temporary files: ${this.directory}`);
    }
    const file = join(this.directory, `${this.nextFile++}.tmp`);
    const fd = openSync(file, "wx+");
    this.files.set(fd, file);
    return fd;
  }

  // Frees a file's disk space early. Anything left is removed with the
  // directory in dispose(), which reports a failure.
  close(fd) {
    const file = this.files.get(fd);
    this.files.delete(fd);
    try {
      this.writeback.synced(fd);
    } finally {
      try {
        closeSync(fd);
        rmSync(file);
      } catch {}
    }
  }

  // Reserve writeback room before each write, including large output chunks.
  // Counting whole 64 KiB pages also covers partial pages on systems whose
  // native pages are larger than 4 KiB.
  write(fd, bytes, position) {
    for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
      const part =
        bytes.byteLength <= 1024 * 1024
          ? bytes
          : bytes.subarray(offset, offset + 1024 * 1024);
      const at = position + offset;
      const size =
        Math.ceil(((at % PAGE_BYTES) + part.byteLength) / PAGE_BYTES) *
        PAGE_BYTES;
      this.writeback.prepare(size);
      writeAll(fd, part, at);
      this.writeback.wrote(fd, size);
    }
  }

  // Takes a list of idle arrays in next-use order. Eviction consumes it
  // from the end before scanning active pages.
  rest(arrays) {
    this.idle = arrays;
    this.idlePage = 0;
  }

  evict() {
    while (this.idle.length) {
      const { pages } = this.idle.at(-1);
      while (this.idlePage < pages.length) {
        const page = pages[this.idlePage++];
        if (page) {
          this.drop(page);
          return;
        }
      }
      this.idle.pop();
      this.idlePage = 0;
    }
    for (let step = 0; ; step++) {
      const slot = this.clock;
      this.clock = (this.clock + 1) % this.slots.length;
      const page = this.slots[slot];
      if (!page) continue;
      // Pinned pages go last, when the cache shrank below them: workers
      // leave pages that are not cached to the main thread.
      const pinned = page.array.pinned;
      if (
        step < this.slots.length * 2 &&
        (page.used || (page.index >= pinned[0] && page.index < pinned[1]))
      ) {
        page.used = false;
        continue;
      }
      this.drop(page);
      return;
    }
  }

  // Only a slot visible to an active search needs a barrier before reuse.
  drop(page, save = true) {
    const array = page.array;
    if (array.readerSlots) this.finishSearch();
    if (save && page.dirty) {
      array.spill ??= new Spill(this, array.stripes);
      array.spill.save(page.index, page.bytes);
      this.writeBytes += PAGE_BYTES;
    }
    array.pages[page.index] = undefined;
    array.residentPages--;
    if (array.directory) {
      const disk = save ? array.spill?.blocks.get(page.index) : undefined;
      array.directory[page.index] = disk === undefined ? -1 : -2 - disk;
    }
    this.slots[page.slot] = undefined;
    this.free.push(page.slot);
    this.used -= PAGE_BYTES;
  }

  // Without `restore`, the caller writes all of the page: it is neither read
  // from its file nor cleared.
  allocate(array, index, restore = true) {
    if (++this.allocations % 64 === 0) this.adjust();
    if (this.used + PAGE_BYTES > this.capacity && this.used) this.evict();
    let slot = this.free.pop();
    if (slot === undefined) {
      slot = this.slots.length;
      if (slot === this.arenas.length * this.arenaPages) {
        this.arenas.push(
          new WebAssembly.Memory({
            initial: this.arenaPages,
            maximum: this.arenaPages,
            shared: true,
          }).buffer,
        );
        this.version++;
        this.generation++;
      }
    }
    const arena = this.arenas[Math.floor(slot / this.arenaPages)];
    let reuse = this.reuse[slot];
    if (reuse?.arena !== arena) {
      const offset = (slot % this.arenaPages) * PAGE_BYTES;
      const bytes = new Uint8Array(arena, offset, PAGE_BYTES);
      reuse = {
        arena,
        offset,
        views: {},
        page: {
          array,
          index,
          bytes,
          values: bytes,
          words: undefined,
          dirty: false,
          used: true,
          slot,
        },
      };
      this.reuse[slot] = reuse;
    }
    const page = reuse.page;
    const bytes = page.bytes;
    if (restore) {
      if (array.spill?.read(index, bytes)) this.readBytes += PAGE_BYTES;
      else bytes.set(ZERO);
    }
    const { views, offset } = reuse;
    const name = array.Type.name;
    views[name] ??= new array.Type(arena, offset, array.items);
    if (array.wordView)
      views.Uint32Array ??= new Uint32Array(arena, offset, PAGE_BYTES / 4);
    page.array = array;
    page.index = index;
    page.values = views[name];
    page.words = array.wordView && views.Uint32Array;
    page.dirty = false;
    page.used = true;
    this.slots[slot] = page;
    this.used += PAGE_BYTES;
    // A store far past the end would turn `pages` into a slow dictionary.
    while (array.pages.length < index) array.pages.push(undefined);
    array.pages[index] = page;
    array.residentPages++;
    if (array.directory) array.map(index, slot);
    return page;
  }

  release(array) {
    for (const page of array.pages) if (page) this.drop(page, false);
    array.pages.length = 0;
  }

  dispose() {
    try {
      this.writeback.wait(false);
    } finally {
      const progress = this.directory
        ? new Progress("Cleaning temporary files", this.files.size + 1)
        : undefined;
      let closed = 0;
      for (const fd of this.files.keys()) {
        this.close(fd);
        progress?.update(++closed);
      }
      if (this.directory) removePath(this.directory, { recursive: true });
      this.directory = undefined;
      this.slots.length = 0;
      this.reuse.length = 0;
      this.free.length = 0;
      this.arenas.length = 0;
      progress?.finish();
      if (this.readBytes || this.writeBytes) {
        console.log(
          `Temporary array I/O: ${(this.readBytes / 1048576).toFixed(1)} MiB read, ${(this.writeBytes / 1048576).toFixed(1)} MiB written`,
        );
      }
    }
  }
}

export class PagedArray {
  constructor(workspace, Type, length = 0) {
    this.workspace = workspace;
    this.Type = Type;
    this.length = length;
    this.items = PAGE_BYTES / Type.BYTES_PER_ELEMENT;
    this.mask = this.items - 1;
    // Exact for the power of two, and faster than dividing.
    this.inverse = 1 / this.items;
    this.pages = [];
    this.residentPages = 0;
    this.stripes = 1;
    this.spill = undefined;
    // Also view each page as 32-bit words; see at().
    this.wordView = false;
    this.directory = undefined;
    // Number of arena slots visible to the current search, zero between jobs.
    this.readerSlots = 0;
    // The blocks whose pages stay cached, for workers to write.
    this.pinned = [0, 0];
  }

  // A resident slot is nonnegative, -1 is an unwritten page, and -2 - n
  // addresses disk page n. Stripes are chosen before the first spill.
  share(stripes = 1) {
    if (this.directory) return this;
    this.stripes = this.spill?.files.length ?? stripes;
    const length = Math.max(64, this.pages.length);
    this.directory = new Int32Array(new SharedArrayBuffer(length * 4)).fill(-1);
    if (this.spill)
      for (const [block, disk] of this.spill.blocks)
        this.directory[block] = -2 - disk;
    this.workspace.version++;
    for (const page of this.pages) if (page) this.map(page.index, page.slot);
    return this;
  }

  map(block, slot) {
    if (
      this.readerSlots &&
      (slot >= this.readerSlots || block >= this.directory.length)
    )
      this.workspace.finishSearch();
    if (block >= this.directory.length) {
      const old = this.directory;
      const size = Math.max(block + 1, old.length * 2);
      this.directory = new Int32Array(new SharedArrayBuffer(size * 4)).fill(-1);
      this.directory.set(old);
      this.workspace.version++;
    }
    if (this.readerSlots) Atomics.store(this.directory, block, slot);
    else this.directory[block] = slot;
  }

  page(index, write = false) {
    return this.at(index, write).values;
  }
  // The position of `index` in its page, after page() or at().
  offset(index) {
    return index & this.mask;
  }
  // The page of `index`: `values`, and `words` if wordView is set.
  at(index, write = false) {
    // Poll in-memory loops too, without an atomic read on every access.
    if ((++this.workspace.accesses & 4095) === 0) this.workspace.check();
    const block = Math.floor(index * this.inverse);
    const page = this.pages[block] ?? this.workspace.allocate(this, block);
    page.used = true;
    if (write) page.dirty = true;
    return page;
  }

  // The values of the page of `index`, for writing all of them.
  whole(index) {
    if ((++this.workspace.accesses & 4095) === 0) this.workspace.check();
    // An uninitialized slot cannot be published to a reader.
    if (this.readerSlots) this.workspace.finishSearch();
    const block = Math.floor(index * this.inverse);
    const page =
      this.pages[block] ?? this.workspace.allocate(this, block, false);
    page.used = true;
    page.dirty = true;
    return page.values;
  }

  get(index) {
    return this.page(index)[index & this.mask];
  }
  set(index, value) {
    this.page(index, true)[index & this.mask] = value;
  }
  push(value) {
    this.set(this.length++, value);
  }

  // Loads the pages of items [from, to), for worker threads to use.
  load(from, to, write = false) {
    for (let index = from; index < to; index += this.items)
      this.at(index, write);
    this.at(to - 1, write);
  }

  // Reads `count` items from `base` into `output` from `at`. set() copies
  // long runs out of shared memory many times faster than a loop.
  read(base, output, count = output.length, at = 0) {
    let offset = 0;
    while (offset < count) {
      const index = base + offset;
      const page = this.page(index);
      const within = index & this.mask;
      const size = Math.min(count - offset, this.items - within);
      if (size > 64)
        output.set(page.subarray(within, within + size), at + offset);
      else
        for (let i = 0; i < size; i++)
          output[at + offset + i] = page[within + i];
      offset += size;
    }
    return output;
  }

  // Read into the same array type, bypassing the cache on misses so a scan
  // cannot evict cached pages.
  stream(base, output, count = output.length, at = 0) {
    const bytes = this.Type.BYTES_PER_ELEMENT;
    let offset = 0;
    while (offset < count) {
      if ((++this.workspace.accesses & 4095) === 0) this.workspace.check();
      const index = base + offset;
      const block = Math.floor(index * this.inverse);
      const within = index & this.mask;
      const size = Math.min(count - offset, this.items - within);
      const page = this.pages[block];
      if (page)
        output.set(page.values.subarray(within, within + size), at + offset);
      else {
        const part = new Uint8Array(
          output.buffer,
          output.byteOffset + (at + offset) * bytes,
          size * bytes,
        );
        if (this.spill?.read(block, part, within * bytes))
          this.workspace.readBytes += part.byteLength;
        else part.fill(0);
      }
      offset += size;
    }
    return output;
  }

  // Cache the prefix before `kept`; stream the rest to preserve it for reuse.
  scan(base, output, count, kept) {
    const cached = Math.max(0, Math.min(count, kept - base));
    this.read(base, output, cached);
    return this.stream(base + cached, output, count - cached, cached);
  }

  // Consume consecutive batches starting at zero. Once the last item of a
  // page is read, even across batches, it needs no further writeback.
  consume(base, output, count) {
    this.stream(base, output, count);
    this.discard(base - (base & this.mask), base + count);
  }

  // Forget fully consumed pages without writing them back. A page shared
  // with rows outside [from, to) must remain readable.
  discard(from, to) {
    const end = Math.floor(to / this.items);
    for (let block = Math.ceil(from / this.items); block < end; block++) {
      const page = this.pages[block];
      if (page) this.workspace.drop(page, false);
    }
  }

  write(base, values, count = values.length) {
    let offset = 0;
    while (offset < count) {
      const index = base + offset;
      const within = index & this.mask;
      const size = Math.min(count - offset, this.items - within);
      // A page that the values cover is not read first.
      const page =
        size === this.items ? this.whole(index) : this.page(index, true);
      if (size > 64) page.set(values.subarray(offset, offset + size), within);
      else for (let i = 0; i < size; i++) page[within + i] = values[offset + i];
      offset += size;
    }
    this.length = Math.max(this.length, base + count);
  }

  dispose() {
    if (this.readerSlots) this.workspace.finishSearch();
    this.workspace.release(this);
    this.spill?.close();
    this.spill = undefined;
    this.directory?.fill(-1);
    this.length = 0;
  }
}

// A page of `fill` words for each type, made once per thread: columns are
// made anew whenever shared arrays change.
const EMPTY = new Map();
function empty(Type, fill) {
  const key = `${Type.name} ${fill}`;
  let page = EMPTY.get(key);
  if (!page) {
    const buffer = new ArrayBuffer(PAGE_BYTES);
    page = {
      values: new Type(buffer),
      words: new Uint32Array(buffer).fill(fill),
    };
    EMPTY.set(key, page);
  }
  return page;
}

// A thread's views of the arenas by type, made once for each generation of
// arenas: columns are made anew whenever shared arrays change.
export class ArenaViews {
  constructor() {
    this.generation = -1;
    this.job = 0;
    this.arenas = [];
    this.types = new Map();
  }
  use(arenas, generation) {
    if (generation === this.generation) return;
    this.generation = generation;
    this.arenas = arenas;
    this.types.clear();
  }
  get(Type) {
    let views = this.types.get(Type);
    if (!views) {
      views = this.arenas.map((arena) => ({
        values: new Type(arena),
        words: new Uint32Array(arena),
      }));
      this.types.set(Type, views);
    }
    return views;
  }
}

// Worker's view of a shared PagedArray. A resident slot stays valid for the
// job. Searches can also read spilled parts and see zeros for unwritten pages.
// Other jobs report misses for the main thread.
export class SharedColumn {
  constructor(
    views,
    directory,
    Type,
    fill = 0,
    fds = undefined,
    parts = undefined,
    column = 0,
  ) {
    this.directory = directory;
    this.views = views;
    this.arenas = views.get(Type);
    this.arenaPages = this.arenas.length
      ? this.arenas[0].values.byteLength / PAGE_BYTES
      : 1;
    this.items = PAGE_BYTES / Type.BYTES_PER_ELEMENT;
    this.mask = this.items - 1;
    // Exact for the power of two, and faster than dividing.
    this.inverse = 1 / this.items;
    this.empty = empty(Type, fill);
    this.base = 0;
    this.missed = false;
    this.lastBlock = -1;
    this.fds = fds;
    this.parts = parts;
    this.column = column;
  }
  at(index) {
    const block = Math.floor(index * this.inverse);
    if (block === this.lastBlock && this.job === this.views.job)
      return this.lastArena;
    const slot =
      block >= this.directory.length
        ? -1
        : this.parts
          ? Atomics.load(this.directory, block)
          : this.directory[block];
    if (slot < 0) {
      this.lastBlock = -1;
      if (this.parts) {
        if (slot < -1) return this.part(index, -2 - slot);
      } else this.missed = true;
      this.base = 0;
      return this.empty;
    }
    this.base = (slot % this.arenaPages) * this.items;
    this.lastBlock = block;
    this.job = this.views.job;
    this.lastArena = this.arenas[Math.floor(slot / this.arenaPages)];
    return this.lastArena;
  }
  part(index, disk) {
    const parts = this.parts;
    const items = this.items / parts.perPage;
    const part = Math.floor((index & this.mask) / items);
    const position = parts.get(this.column, this.fds, disk, part);
    this.base = (position - part) * items;
    return parts.views[this.column];
  }
  offset(index) {
    return this.base + (index & this.mask);
  }
  page(index) {
    return this.at(index).values;
  }
  get(index) {
    return this.page(index)[this.offset(index)];
  }
}

// Gathers columns into the order of `indices`: row indices[i] of a column with
// `rows` rows becomes row i. Each output window is
// filled while the column is read in order, so a column larger than the cache
// costs a few sequential passes instead of a page load per row.
export class Permutation {
  constructor(workspace, indices, rows, label) {
    this.workspace = workspace;
    this.length = indices.length;
    this.rows = rows;
    this.block = new Uint32Array(16384);
    // Source row -> target row + 1; 0 marks a row that is dropped.
    this.targets = new IndexArray(workspace);
    const progress = label && new Progress(label, indices.length);
    for (let base = 0; base < indices.length; base += this.block.length) {
      const count = Math.min(this.block.length, indices.length - base);
      indices.read(base, this.block, count);
      for (let i = 0; i < count; i++)
        this.targets.set(this.block[i], base + i + 1);
      progress?.update(base + count);
    }
    progress?.finish();
  }

  // Returns `source` gathered into a new column, and disposes `source`. The
  // output window's pages stay cached while workers copy blocks of source
  // rows into it; rows across pages are left to the main thread. The output
  // spreads over as many files as `source`.
  // With `words`, rows are copied as 32-bit words, which keeps any bits of
  // floats, and the output has word views; see PagedArray.at(). `visit` is
  // called with the output and each window's rows [start, end) once they are
  // in place, while their pages are still cached.
  apply(
    source,
    stride,
    pool,
    words = false,
    label = undefined,
    visit = undefined,
  ) {
    const output = new PagedArray(
      this.workspace,
      source.Type,
      this.length * stride,
    );
    output.wordView = words;
    output.share(source.stripes);
    source.share();
    const record = words ? new Uint32Array(stride) : new source.Type(stride);
    const { nodes: targets, later } = pool;
    const rowBytes = stride * source.Type.BYTES_PER_ELEMENT;
    const pages = Math.floor(this.workspace.capacity / PAGE_BYTES);
    const targetBytes = targets.BYTES_PER_ELEMENT;
    const block = Math.min(
      later.length,
      Math.max(
        1,
        Math.floor((pages * PAGE_BYTES) / 8 / (rowBytes + targetBytes)),
      ),
    );
    // Keep one batch of source rows and targets alongside the destination.
    // All three ranges can start partway through a page.
    const reserved =
      Math.ceil((block * rowBytes) / PAGE_BYTES) +
      Math.ceil((block * targetBytes) / PAGE_BYTES) +
      3;
    const window = Math.max(
      1,
      Math.floor((Math.max(1, pages - reserved) * PAGE_BYTES) / rowBytes),
    );
    const progress =
      label && new Progress(label, Math.ceil(this.length / window) * this.rows);
    // The lowest and highest target + 1 of each block of source rows, found
    // as the first window reads them: a later window that none of a block's
    // rows land in skips the block.
    const low = new Float64Array(Math.ceil(this.rows / block));
    const high = new Float64Array(low.length);
    for (let start = 0; start < this.length; start += window) {
      const end = Math.min(this.length, start + window);
      output.pinned = [
        Math.floor((start * stride) / output.items),
        Math.floor((end * stride - 1) / output.items) + 1,
      ];
      output.load(start * stride, end * stride, true);
      for (let base = 0; base < this.rows; base += block) {
        const b = base / block;
        if (start && (high[b] <= start || low[b] > end)) continue;
        const count = Math.min(block, this.rows - base);
        const sourceStart = base * stride;
        const sourceEnd = (base + count) * stride;
        this.targets.read(base, targets, count);
        if (!start) {
          low[b] = Number.POSITIVE_INFINITY;
          for (let i = 0; i < count; i++)
            if (targets[i]) {
              low[b] = Math.min(low[b], targets[i]);
              high[b] = Math.max(high[b], targets[i]);
            }
          if (low[b] > end) {
            if (high[b] === 0) source.discard(sourceStart, sourceEnd);
            continue;
          }
        }
        source.load(sourceStart, sourceEnd);
        pool.copy(source, output, stride, count, base, start, end, words);
        for (let i = 0; i < count; i++) {
          if (!later[i]) continue;
          const from = (base + i) * stride;
          const to = (targets[i] - 1) * stride;
          if (!words) {
            source.read(from, record);
            output.write(to, record);
            continue;
          }
          // Rows of words lie within a page.
          const values = source.at(from).words;
          for (let d = 0; d < stride; d++)
            record[d] = values[(from & source.mask) + d];
          const out = output.at(to, true).words;
          for (let d = 0; d < stride; d++)
            out[(to & output.mask) + d] = record[d];
        }
        // No later window uses this block once its last target is in place:
        // dropped here, its pages are not written back when the cache is full.
        if (high[b] <= end) source.discard(sourceStart, sourceEnd);
        progress?.update(Math.floor(start / window) * this.rows + base + count);
      }
      visit?.(output, start, end);
    }
    output.pinned = [0, 0];
    source.dispose();
    progress?.finish();
    return output;
  }

  dispose() {
    this.targets.dispose();
  }
}

// Keep hot integer lookups separate from the mixed attribute types so V8 can
// specialize their TypedArray access during heap and spatial-grid traversal.
export class IndexArray extends PagedArray {
  constructor(workspace) {
    super(workspace, Uint32Array);
  }
  get(index) {
    return this.page(index)[index & this.mask];
  }
  set(index, value) {
    this.page(index, true)[index & this.mask] = value;
  }
}

// Cleanup never throws, so it cannot replace a conversion error. A failure is
// reported with the path, so the leftover can be removed by hand.
export function removePath(file, options) {
  try {
    rmSync(file, options);
  } catch (error) {
    if (error.code !== "ENOENT")
      console.warn(`Could not remove ${file} (${error.code ?? error.message})`);
  }
}

function writeAll(fd, bytes, position) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (!count) throw new Error("Unable to write output or temporary file");
    offset += count;
  }
}
