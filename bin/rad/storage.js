import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "#gsl/files";
import { tmpdir } from "#gsl/host";
import { collect, outsideBytes, sharedBuffer } from "#gsl/memory";
import { join } from "#gsl/path";
export { collect, sharedBuffer } from "#gsl/memory";
import { checkRun } from "../run-state.js";
import { Progress } from "./progress.js";
import { PAGE_BYTES, Spill } from "./spill.js";
import { Writeback } from "./writeback.js";

export { PAGE_BYTES, readAll } from "./spill.js";
export { GIB } from "../units.js";
// Memory the budget keeps for growth between measurements.
const MARGIN = 64 * 1024 ** 2;
// Copied over new pages: fill(0) writes shared memory a byte at a time.
const ZERO = new Uint8Array(PAGE_BYTES);

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
    this.tempBytes = 0;
    this.peakTempBytes = 0;
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
    checkRun(this.cancelled);
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
      outsideBytes(this.slots.length * PAGE_BYTES),
    );
  }

  // Measures the rest of the process anew once its garbage is collected, as
  // a phase starts.
  settle() {
    collect();
    this.outside = outsideBytes(this.slots.length * PAGE_BYTES);
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
    const free = this.free.filter((slot) => slot < slots);
    for (let slot = slots; slot < this.slots.length; slot++) {
      const page = this.slots[slot];
      if (!page) continue;
      // Keep dirty pages in vacant slots of the surviving arenas before spilling.
      if (page.dirty && free.length) {
        this.drop(page, false);
        const kept = this.attach(page.array, page.index, free.pop(), false);
        kept.bytes.set(page.bytes);
        kept.dirty = true;
        kept.used = page.used;
      } else this.drop(page);
    }
    this.slots.length = slots;
    this.reuse.length = slots;
    this.free = free;
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
    this.files.set(fd, { path: file, size: 0 });
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
        rmSync(file.path);
        this.tempBytes -= file.size;
      } catch {}
    }
  }

  // Reserve writeback room before each write, including large output chunks.
  // Counting whole 64 KiB pages also covers partial pages on systems whose
  // native pages are larger than 4 KiB.
  write(fd, bytes, position) {
    const file = this.files.get(fd);
    for (let offset = 0; offset < bytes.byteLength; ) {
      const end = Math.min(offset + 1024 * 1024, bytes.byteLength);
      const at = position + offset;
      const size =
        Math.ceil(((at % PAGE_BYTES) + (end - offset)) / PAGE_BYTES) *
        PAGE_BYTES;
      this.writeback.prepare(size);
      while (offset < end) {
        const count = writeSync(
          fd,
          bytes,
          offset,
          end - offset,
          position + offset,
        );
        if (!count) throw new Error("Unable to write output or temporary file");
        offset += count;
        const length = position + offset;
        if (file && length > file.size) {
          this.tempBytes += length - file.size;
          file.size = length;
          this.peakTempBytes = Math.max(this.peakTempBytes, this.tempBytes);
        }
      }
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
    if (this.used + PAGE_BYTES > this.capacity) this.evict();
    let slot = this.free.pop();
    if (slot === undefined) {
      slot = this.slots.length;
      if (slot === this.arenas.length * this.arenaPages) {
        this.arenas.push(sharedBuffer(this.arenaBytes));
        this.version++;
        this.generation++;
      }
    }
    return this.attach(array, index, slot, restore);
  }

  attach(array, index, slot, restore) {
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
          `Temporary array I/O: ${(this.readBytes / 1048576).toFixed(1)} MiB read, ${(this.writeBytes / 1048576).toFixed(1)} MiB written, ${(this.peakTempBytes / 1048576).toFixed(1)} MiB peak on disk`,
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
  at(index, write = false, allowEmpty = false) {
    // Poll in-memory loops too, without an atomic read on every access.
    if ((++this.workspace.accesses & 4095) === 0) this.workspace.check();
    const block = Math.floor(index * this.inverse);
    const resident = this.pages[block];
    // Bulk reads can copy zeros from an unwritten page without caching it.
    if (!resident && allowEmpty && !this.spill?.blocks.has(block))
      return empty(this.Type);
    const page = resident ?? this.workspace.allocate(this, block);
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
      const page = this.at(index, false, true).values;
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
      // Each iteration can read a full page from disk.
      if ((++this.workspace.accesses & 63) === 0) this.workspace.check();
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

  // A single-pass permutation input. Consecutive ranges share boundary pages.
  consumingRange(first = 0, length = this.length - first) {
    return {
      length,
      read: (base, output, count) => this.consume(first + base, output, count),
    };
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

// One zero page per type and thread, reused across column views.
const EMPTY = new Map();
function empty(Type) {
  let page = EMPTY.get(Type);
  if (!page) {
    const buffer = new ArrayBuffer(PAGE_BYTES);
    page = {
      values: new Type(buffer),
      words: new Uint32Array(buffer),
    };
    EMPTY.set(Type, page);
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
export const DISK_PAGE = Symbol("page owned by the I/O worker");
export class SharedColumn {
  constructor(views, directory, Type, fds, parts, column = 0) {
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
    this.empty = empty(Type);
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
    if (this.fds === null) throw DISK_PAGE;
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

// Source row -> target row + 1; zero marks a row that is dropped. Bucket by
// source range until it fits in the cache. The input streams past the active
// range, and a split appends to at most 64 bucket tails.
function invert(indices, rows, targets, block, label) {
  const { workspace, items } = targets;
  const progress = label && new Progress(label, 2 * indices.length);
  let completed = 0;

  function fill(order, first, size, paired) {
    const stride = paired ? 2 : 1;
    const read = paired ? order.consume : (order.stream ?? order.read);
    let bins;
    let span;
    for (let base = 0; base < order.length; base += block.length) {
      const fit = Math.floor(workspace.capacity / PAGE_BYTES) * items;
      if (!bins && size > fit) {
        span = Math.max(fit, Math.ceil(size / (64 * items)) * items);
        bins = [];
      }
      const count = Math.min(block.length, order.length - base);
      read.call(order, base, block, count);
      for (let i = 0; i < count; i += stride) {
        const row = block[i];
        const target = paired ? block[i + 1] : base + i + 1;
        if (bins) {
          const b = Math.floor((row - first) / span);
          bins[b] ??= new IndexArray(workspace);
          bins[b].push(row);
          bins[b].push(target);
        } else targets.set(row, target);
      }
      if (!paired) completed += count;
      if (!bins) completed += count / stride;
      progress?.update(completed);
    }
    if (paired) order.dispose();
    if (!bins) return;
    for (let b = 0; b < bins.length; b++) {
      if (bins[b])
        fill(bins[b], first + b * span, Math.min(span, size - b * span), true);
    }
  }

  fill(indices, 0, rows, false);
  progress?.finish();
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
    this.targets = new IndexArray(workspace);
    invert(indices, rows, this.targets, this.block, label);
  }

  // Returns `source` gathered into a new column, and disposes `source`. The
  // output window's pages stay cached while source blocks are copied into it.
  // A supplied pool copies resident rows in parallel. The output spreads
  // over as many files as `source`.
  // With `words`, rows are copied as 32-bit words, which keeps any bits of
  // floats, and the output has word views; see PagedArray.at(). `visit` is
  // called with the output and each window's rows [start, end) once they are
  // in place, while their pages are still cached. With `keep`, `source` is
  // left intact.
  apply(
    source,
    stride,
    pool,
    { words = false, label, visit, keep = false } = {},
  ) {
    const output = new PagedArray(
      this.workspace,
      source.Type,
      this.length * stride,
    );
    output.wordView = words;
    if (pool) {
      output.share(source.stripes);
      source.share();
    } else output.stripes = source.stripes;
    const record = words ? new Uint32Array(stride) : new source.Type(stride);
    const targets = pool?.nodes ?? this.block;
    const later = pool?.later;
    const rowBytes = stride * source.Type.BYTES_PER_ELEMENT;
    const pages = Math.floor(this.workspace.capacity / PAGE_BYTES);
    const targetBytes = targets.BYTES_PER_ELEMENT;
    const block = Math.min(
      later?.length ?? targets.length,
      Math.max(
        1,
        Math.floor((pages * PAGE_BYTES) / 8 / (rowBytes + targetBytes)),
      ),
    );
    // Workers need a source batch in the cache. The main thread reads only
    // the current row. Each range can start partway through a page.
    const reserved =
      Math.ceil(((pool ? block : 1) * rowBytes) / PAGE_BYTES) +
      Math.ceil((block * targetBytes) / PAGE_BYTES) +
      3;
    const room = () =>
      Math.floor(this.workspace.capacity / PAGE_BYTES) - reserved;
    const progress = label && new Progress(label, 1);
    // Each block's remaining targets lie in [nextTarget, high). Advancing
    // its lower bound keeps track of rows copied before a window shrinks.
    const nextTarget = new Float64Array(Math.ceil(this.rows / block));
    const high = new Float64Array(nextTarget.length);
    for (let start = 0, end, done = 0; start < this.length; start = end) {
      const firstPage = Math.floor((start * stride) / output.items);
      // The end of the rows that lie in `count` pages from the first.
      const within = (count) =>
        Math.max(
          start + 1,
          Math.floor(((firstPage + count) * output.items) / stride),
        );
      // A window is the whole pages that fit now. A sixty-fourth of them
      // stays free, for what `visit` writes and so that eviction finds a
      // page without passing every pinned one.
      const fit = room();
      end = Math.min(this.length, within(fit - Math.max(16, fit >>> 6)));
      // Progress takes the windows left to be as long as this one.
      const windows = done + Math.ceil((this.length - start) / (end - start));
      output.pinned = [
        firstPage,
        Math.floor((end * stride - 1) / output.items) + 1,
      ];
      if (pool) output.load(start * stride, end * stride, true);
      for (let base = 0; base < this.rows; base += block) {
        const b = base / block;
        const begin = Math.max(start, nextTarget[b]);
        if (start && (begin >= end || high[b] <= begin)) continue;
        const count = Math.min(block, this.rows - base);
        const sourceStart = base * stride;
        const sourceEnd = (base + count) * stride;
        // A window that no longer fits ends early. The blocks before this
        // one keep the rows they have put past its new end.
        const fits = within(room() - 16);
        if (fits < end) {
          end = fits;
          output.pinned[1] = Math.floor((end * stride - 1) / output.items) + 1;
          if (begin >= end) continue;
        }
        this.targets.read(base, targets, count);
        if (!start) {
          nextTarget[b] = Number.POSITIVE_INFINITY;
          for (let i = 0; i < count; i++)
            if (targets[i]) {
              nextTarget[b] = Math.min(nextTarget[b], targets[i] - 1);
              high[b] = Math.max(high[b], targets[i]);
            }
          if (nextTarget[b] >= end) {
            if (high[b] === 0 && !keep) source.discard(sourceStart, sourceEnd);
            continue;
          }
        }
        if (pool) {
          source.load(sourceStart, sourceEnd);
          pool.copy(source, output, stride, count, base, begin, end, words);
        }
        nextTarget[b] = end;
        for (let i = 0; i < count; i++) {
          if (later && !later[i]) continue;
          const target = targets[i] - 1;
          if (target < begin || target >= end) continue;
          const from = (base + i) * stride;
          const to = target * stride;
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
        if (high[b] <= end && !keep) source.discard(sourceStart, sourceEnd);
        progress?.update((done + (base + count) / this.rows) / windows);
      }
      visit?.(output, start, end);
      done++;
    }
    output.pinned = [0, 0];
    if (!keep) source.dispose();
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
