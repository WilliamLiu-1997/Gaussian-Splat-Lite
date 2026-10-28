import { fdatasync } from "node:fs";
import { getSystemErrorName } from "node:util";

// The CLI thread can receive these requests while conversion runs synchronous
// code. Completion is shared so the converter need not yield its event loop.
export function syncFiles(files, state, cancelled) {
  // A batch can still be in the message queue when cancellation arrives.
  // Acknowledge it without submitting any more native I/O.
  if (Atomics.load(cancelled, 0)) {
    Atomics.store(state, 0, 0);
    Atomics.notify(state, 0);
    return;
  }
  for (const fd of files)
    fdatasync(fd, (error) => {
      if (error) Atomics.compareExchange(state, 1, 0, error.errno);
      Atomics.sub(state, 0, 1);
      Atomics.notify(state, 0);
    });
}

// Bounds buffered writes that have not yet been confirmed written back. One
// batch syncs while the next fills; only the older batch is acknowledged when
// its sync completes, even if the same files have been written again.
export class Writeback {
  // `check` throws once the conversion is cancelled.
  constructor(limit, submit, check) {
    this.limit = limit;
    this.submit = submit;
    this.check = check;
    this.files = new Map();
    this.bytes = 0;
    this.pending = undefined;
    // Outstanding syncs, then the first negative system error number.
    this.state = new Int32Array(new SharedArrayBuffer(8));
  }

  complete() {
    if (!this.pending || Atomics.load(this.state, 0)) return;
    this.pending = undefined;
    const error = Atomics.load(this.state, 1);
    if (error)
      throw new Error(
        `Unable to write back file data: ${getSystemErrorName(error)}`,
      );
  }

  // Cancellation interrupts conversion, but keeps the batch tracked. Cleanup
  // waits without cancellation so every fd stays open until its sync returns.
  wait(cancellable = true) {
    if (!this.pending) return;
    for (;;) {
      if (cancellable) this.check();
      const remaining = Atomics.load(this.state, 0);
      if (!remaining) break;
      Atomics.wait(this.state, 0, remaining, cancellable ? 100 : undefined);
    }
    this.complete();
  }

  // Called before writing: the write itself must fit, including while an
  // earlier batch is still being written back.
  prepare(bytes) {
    this.check();
    this.complete();
    if (this.bytes + (this.pending?.bytes ?? 0) + bytes <= this.limit) return;
    this.wait();
    if (this.bytes + bytes > this.limit) {
      this.flush();
      this.wait();
    }
  }

  wrote(fd, bytes) {
    this.files.set(fd, (this.files.get(fd) ?? 0) + bytes);
    this.bytes += bytes;
    // Each sync costs a call per file, so batches are large; the last
    // quarter of the limit takes writes while the older batch syncs.
    if (!this.pending && this.bytes >= (this.limit * 3) / 4) this.flush();
  }

  flush() {
    this.check();
    const files = [...this.files.keys()];
    Atomics.store(this.state, 0, files.length);
    Atomics.store(this.state, 1, 0);
    this.pending = { files: this.files, bytes: this.bytes };
    this.submit(files, this.state);
    this.files = new Map();
    this.bytes = 0;
  }

  // Before a file is closed, its outstanding syncs must finish: otherwise a
  // queued sync could operate on a different file that reuses its descriptor.
  synced(fd) {
    if (this.pending?.files.has(fd)) this.wait(false);
    this.bytes -= this.files.get(fd) ?? 0;
    this.files.delete(fd);
  }
}
