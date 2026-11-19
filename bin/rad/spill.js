import { readSync } from "node:fs";

export const PAGE_BYTES = 65536;
const PART_BYTES = 8192;
const PARTS = (3 * 1024 * 1024) / PART_BYTES;

// Each column assigns consecutive disk pages on its first dirty evictions.
// A logical page without a disk address reads as zeros.
export class Spill {
  constructor(workspace, stripes) {
    this.workspace = workspace;
    this.files = new Array(stripes);
    this.blocks = new Map();
    this.version = ++workspace.diskVersion;
  }

  save(block, bytes) {
    const disk = this.blocks.get(block) ?? this.blocks.size;
    const stripe = disk % this.files.length;
    if (this.files[stripe] === undefined) {
      this.files[stripe] = this.workspace.file();
      this.workspace.version++;
    }
    this.workspace.write(
      this.files[stripe],
      bytes,
      Math.floor(disk / this.files.length) * PAGE_BYTES,
    );
    // Readers may still cache parts of the previous image between jobs.
    if (disk === this.blocks.size) this.blocks.set(block, disk);
    else this.version = ++this.workspace.diskVersion;
  }

  read(block, bytes, offset = 0) {
    const disk = this.blocks.get(block);
    if (disk === undefined) return false;
    readAll(
      this.files[disk % this.files.length],
      bytes,
      Math.floor(disk / this.files.length) * PAGE_BYTES + offset,
    );
    return true;
  }

  close() {
    for (const fd of this.files) if (fd !== undefined) this.workspace.close(fd);
  }
}

// The three grid columns share one reader's allowance. A spilling entries
// table can use space left idle by resident hash slots and removal bits.
export class Parts {
  constructor(versions) {
    this.versions = versions;
    this.perPage = PAGE_BYTES / PART_BYTES;
    this.bytesRead = 0;
  }

  get(column, files, disk, part) {
    if (!this.bytes) {
      this.bytes = new Uint8Array(PARTS * PART_BYTES);
      const words = new Uint32Array(this.bytes.buffer);
      const integers = { values: words, words };
      // Entries, hash slots and the removal bitmap, in search order.
      this.views = [
        { values: new Float32Array(this.bytes.buffer), words },
        integers,
        integers,
      ];
      this.numbers = new Float64Array(PARTS);
      this.stamps = new Float64Array(PARTS);
    }
    const version = this.versions[column];
    const number = disk * this.perPage + part;
    const slot = (number + column * (PARTS / 3)) % PARTS;
    if (this.stamps[slot] !== version || this.numbers[slot] !== number) {
      const offset = slot * PART_BYTES;
      readAll(
        files[disk % files.length],
        this.bytes.subarray(offset, offset + PART_BYTES),
        Math.floor(disk / files.length) * PAGE_BYTES + part * PART_BYTES,
      );
      this.numbers[slot] = number;
      this.stamps[slot] = version;
      this.bytesRead += PART_BYTES;
    }
    return slot;
  }
}

export function readAll(fd, bytes, position) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (!count) throw new Error("Truncated input or temporary file");
    offset += count;
  }
  return bytes;
}
