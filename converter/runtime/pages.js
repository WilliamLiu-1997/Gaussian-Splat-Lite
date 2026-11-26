// Logical converter files share a temporary address space. Deleted spill pages
// can be reused immediately, including across different converter columns.
export const PAGE_BYTES = 65536;
// Writable streams replace their file on close. Keep each commit bounded on disk.
export const SEGMENT_BYTES = 48 * 1024 ** 2;
const segmentPages = SEGMENT_BYTES / PAGE_BYTES;
const zero = new Uint8Array(PAGE_BYTES);

export class PageStore {
  constructor(handle) {
    this.handle = handle;
    this.free = new Map();
    this.reuse = [];
    this.length = 0;
  }

  allocate() {
    if (!this.reuse.length) {
      if (!this.free.size) return this.length++;
      const [segment, slots] = this.free.entries().next().value;
      this.free.delete(segment);
      this.reuse = slots.sort((a, b) => b - a);
    }
    return this.reuse.pop();
  }

  write(file, bytes, at) {
    let position = at;
    for (let offset = 0; offset < bytes.length; ) {
      const index = Math.floor(position / PAGE_BYTES);
      const within = position % PAGE_BYTES;
      const count = Math.min(PAGE_BYTES - within, bytes.length - offset);
      let slot = file.pages[index];
      if (slot === undefined) {
        slot = this.allocate();
        if (count < PAGE_BYTES) this.handle.write(zero, slot * PAGE_BYTES);
        file.pages[index] = slot;
      }
      this.handle.write(
        bytes.subarray(offset, offset + count),
        slot * PAGE_BYTES + within,
      );
      offset += count;
      position += count;
    }
    file.size = Math.max(file.size, position);
    return bytes.length;
  }

  read(file, bytes, at) {
    let position = at;
    const size = Math.min(bytes.length, Math.max(0, file.size - position));
    for (let offset = 0; offset < size; ) {
      const within = position % PAGE_BYTES;
      const count = Math.min(PAGE_BYTES - within, size - offset);
      const slot = file.pages[Math.floor(position / PAGE_BYTES)];
      const part = bytes.subarray(offset, offset + count);
      if (slot === undefined) part.fill(0);
      else {
        const n = this.handle.read(part, slot * PAGE_BYTES + within);
        if (n !== count) throw new Error("Incomplete browser temporary file.");
      }
      position += count;
      offset += count;
    }
    return size;
  }

  release(file) {
    // Keep recycled writes together even when the released logical file was
    // striped across many physical segments.
    for (const slot of file.pages) {
      if (slot === undefined) continue;
      const segment = Math.floor(slot / segmentPages);
      let slots = this.free.get(segment);
      if (!slots) {
        slots = [];
        this.free.set(segment, slots);
      }
      slots.push(slot);
    }
  }
}
