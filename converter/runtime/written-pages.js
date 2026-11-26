import { PAGE_BYTES } from "./pages.js";

export const writtenBytes = 8 * 1024 ** 2;

// A page read between writes can use its current image before the stream closes.
export class WrittenPages {
  bytes = new Uint8Array(writtenBytes);
  tags = new Float64Array(writtenBytes / PAGE_BYTES).fill(-1);

  remember(at, data) {
    for (let i = 0; i < data.length; ) {
      const page = Math.floor((at + i) / PAGE_BYTES);
      const slot = page % this.tags.length;
      const offset = (at + i) % PAGE_BYTES;
      const count = Math.min(PAGE_BYTES - offset, data.length - i);
      if (count === PAGE_BYTES || this.tags[slot] === page) {
        this.tags[slot] = page;
        this.bytes.set(data.subarray(i, i + count), slot * PAGE_BYTES + offset);
      }
      i += count;
    }
  }

  read(page, output) {
    const slot = page % this.tags.length;
    if (this.tags[slot] !== page) return false;
    const start = slot * PAGE_BYTES;
    output.set(this.bytes.subarray(start, start + PAGE_BYTES));
    return true;
  }
}
