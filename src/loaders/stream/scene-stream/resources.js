import { DefaultLoadingManager } from "three";
import { abortable } from "../../../runtime/abort.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { sourceLimits, sourceMemory } from "./memory.js";

export function logicalUrl(url) {
  return new URL(
    url,
    typeof document === "undefined" ? undefined : document.baseURI,
  ).href;
}

/** Keep the logical path even when a local LoadingManager returns a blob URL. */
export async function readSceneBytes(
  url,
  options,
  signal,
  limit,
  optional = false,
) {
  const manager = options.manager ?? DefaultLoadingManager;
  const resolved = logicalUrl(manager.resolveURL(url));
  manager.itemStart(resolved);
  let response;
  try {
    signal.throwIfAborted();
    response = await fetch(resolved, {
      ...requestOptions(options, resolved, logicalUrl(options.url)),
      signal,
    });
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    const { chunks, size } = await readResponse(
      response,
      limit,
      () => {},
      signal,
    );
    signal.throwIfAborted();
    return joinBytes(chunks, size);
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    manager.itemError(resolved);
    throw error;
  } finally {
    manager.itemEnd(resolved);
  }
}

export class SceneBudgetError extends Error {
  constructor(sourceKey, phase, requestedBytes, availableBytes) {
    super(
      `Scene source "${sourceKey}" ${phase} reservation failed: need ${requestedBytes} bytes, ${availableBytes} available`,
    );
    this.name = "SceneBudgetError";
    this.sourceKey = sourceKey;
    this.phase = phase;
    this.requestedBytes = requestedBytes;
    this.availableBytes = availableBytes;
  }
}

// Match the stream idle cooldown; memory pressure can evict sources sooner.
const SOURCE_COOLDOWN_MS = 2000;

/** One cancellation owner per storage resource, not per requesting node. */
export class SceneSources {
  constructor(load, memory, signal, onChange) {
    this.onChange = onChange;
    this.waiters = new Set();
    this.closing = new Set();
    this.load = load;
    this.memory = memory;
    this.signal = signal;
    this.entries = new Map();
    this.wasmHeaps = new Map();
    this.disposed = false;
    this._cachedBytes = 0;
    this._pendingBytes = 0;
  }
  get cachedBytes() {
    return this._cachedBytes;
  }
  get pendingBytes() {
    return this._pendingBytes;
  }
  trim(cpu = 0, gpu = 0) {
    let available = this.memory.maxCpu - this.memory.cpu;
    for (const [key, entry] of this.entries) {
      if (available >= cpu && this.memory.gpu + gpu <= this.memory.maxGpu)
        break;
      if (entry.users || !entry.handle) continue;
      this.close(key, entry);
      available += entry.cpuBytes;
    }
  }
  acquire(source) {
    this.signal.throwIfAborted();
    if (this.disposed)
      throw new DOMException("Scene source cache disposed", "AbortError");
    let entry = this.entries.get(source.key);
    if (!entry) {
      let envelope = sourceMemory(source);
      if (envelope > this.memory.maxCpu)
        throw new Error(
          `Scene source requires at least ${envelope} maxResidentCpuBytes`,
        );
      this.trim(envelope);
      const initialRelease = this.memory.reserve(envelope);
      if (!initialRelease) return undefined;
      this._pendingBytes += Number.isFinite(envelope) ? envelope : 0;
      const reserveRequired = (bytes, phase) => {
        const release = this.memory.reserve(bytes);
        if (typeof release !== "function")
          throw new SceneBudgetError(
            source.key,
            phase,
            bytes,
            this.memory.maxCpu - this.memory.cpu,
          );
        return release;
      };
      const reservations = [initialRelease];
      const releaseMemory = () => {
        for (const release of reservations) release();
        if (entry.pending) {
          this._pendingBytes -= entry.cpuBytes;
          entry.pending = false;
        }
        entry.cpuBytes = 0;
      };
      let admitted = {
        ...source,
        maxInputBytes: sourceLimits(source).maxInputBytes,
      };
      const decodeSource = { ...source };
      Object.defineProperty(decodeSource, "admit", {
        value: (update) => {
          controller.signal.throwIfAborted();
          if (
            source.maxPoints !== undefined &&
            update.maxPoints > source.maxPoints
          )
            throw new Error(
              `Source header requires ${update.maxPoints} points, exceeding source.maxPoints ${source.maxPoints}`,
            );
          if (
            source.maxInputBytes !== undefined &&
            update.maxInputBytes > source.maxInputBytes
          )
            throw new Error(
              `Source requires ${update.maxInputBytes} encoded bytes, exceeding source.maxInputBytes ${source.maxInputBytes}`,
            );
          const next = { ...admitted, ...update };
          next.maxWasmBytes = Math.max(
            next.maxWasmBytes ?? 0,
            sourceLimits({ ...next, maxWasmBytes: source.maxWasmBytes })
              .maxWasmBytes,
          );
          const bytes = sourceMemory(next);
          if (bytes > envelope) {
            const release = this.memory.reserve(bytes - envelope);
            if (!release)
              throw new Error(
                `Source header/retained WASM requires at least ${bytes} source bytes; maxResidentCpuBytes has ${this.memory.maxCpu - this.memory.cpu + envelope} available`,
              );
            reservations.push(release);
            const extra = Number.isFinite(bytes) ? bytes - envelope : 0;
            this._pendingBytes += extra;
            entry.cpuBytes += extra;
            envelope = bytes;
          }
          admitted = next;
          return sourceLimits(admitted);
        },
      });
      let pinned = false;
      Object.defineProperty(decodeSource, "pinWasm", {
        value: (worker, capacity, disposed) => {
          if (pinned) return;
          const heapLimit = sourceLimits(admitted).maxWasmBytes;
          let heap = this.wasmHeaps.get(worker);
          if (
            !Number.isSafeInteger(capacity) ||
            capacity < 0 ||
            capacity > Math.max(heapLimit, heap?.bytes ?? 0)
          )
            throw new SceneBudgetError(
              source.key,
              "pinWasm capacity",
              capacity,
              Math.max(heapLimit, heap?.bytes ?? 0),
            );
          // Keep the cap, not just the sample: later range reordering can grow the same heap.
          const bound = Math.max(capacity, heapLimit);
          const delta = Math.max(0, bound - (heap?.bytes ?? 0));
          // Transfer the already-held heap allowance to shared worker ownership.
          // No await: the replacement reservations cannot lose their released space.
          for (const release of reservations) release();
          reservations.length = 0;
          let releaseHeap;
          try {
            reservations.push(
              reserveRequired(envelope - heapLimit, "pinWasm source"),
            );
            releaseHeap = reserveRequired(delta, "pinWasm heap");
          } catch (error) {
            releaseMemory();
            // A failed transfer cannot leave a live, unaccounted linear memory.
            worker.dispose?.(error);
            throw error;
          }
          this._pendingBytes -= entry.cpuBytes;
          entry.cpuBytes = Number.isFinite(envelope) ? envelope - heapLimit : 0;
          this._pendingBytes += entry.cpuBytes;
          entry.worker = worker;
          pinned = true;
          if (!heap) {
            heap = { bytes: bound, releases: [releaseHeap] };
            this.wasmHeaps.set(worker, heap);
            const ownedHeap = heap;
            void disposed.then(() => {
              for (const release of ownedHeap.releases) release();
              this.wasmHeaps.delete(worker);
              // Invalidate handles before waking retries; pending loads still close after completion.
              for (const [key, ownedEntry] of this.entries)
                if (ownedEntry.worker === worker) this.close(key, ownedEntry);
              this.notify();
            });
          } else {
            heap.bytes = Math.max(heap.bytes, bound);
            heap.releases.push(releaseHeap);
          }
        },
      });
      const controller = new AbortController();
      const abort = () => this.close(source.key, entry);
      this.signal.addEventListener("abort", abort, { once: true });
      let resolveClosed;
      let rejectClosed;
      const closed = new Promise((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
      });
      void closed.catch(() => {});
      entry = {
        users: 0,
        pending: true,
        cpuBytes: Number.isFinite(envelope) ? envelope : 0,
        cacheBytes: 0,
        controller,
        handle: undefined,
        releaseMemory,
        abort,
        closed,
        resolveClosed,
        rejectClosed,
      };
      this.entries.set(source.key, entry);
      const owned = entry;
      entry.promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.load(decodeSource, controller.signal);
        })
        .then(async (handle) => {
          if (controller.signal.aborted) {
            await handle.dispose();
            controller.signal.throwIfAborted();
          }
          owned.handle = handle;
          this._pendingBytes -= owned.cpuBytes;
          owned.pending = false;
          const cacheBytes = handle.info?.byteLength;
          if (
            pinned &&
            Number.isSafeInteger(cacheBytes) &&
            cacheBytes >= 0 &&
            cacheBytes <= envelope - sourceLimits(admitted).maxWasmBytes
          ) {
            // Encoded inputs and decoder temporaries are gone; only cached arrays remain.
            for (const release of reservations) release();
            reservations.length = 0;
            try {
              reservations.push(reserveRequired(cacheBytes, "cache retention"));
              owned.cpuBytes = cacheBytes;
            } catch (error) {
              owned.handle = undefined;
              await Promise.resolve()
                .then(() => handle.dispose())
                .catch(() => {});
              throw error;
            }
          }
          owned.cacheBytes =
            Number.isSafeInteger(cacheBytes) && cacheBytes >= 0
              ? cacheBytes
              : 0;
          this._cachedBytes += owned.cacheBytes;
          this.notify();
          return handle;
        });
      // Callers can release a queued request before awaiting its promise.
      void entry.promise.catch(() => {});
    }
    clearTimeout(entry.timer);
    if (!entry.users) {
      entry.released = new Promise((resolve, reject) => {
        entry.resolveReleased = resolve;
        entry.rejectReleased = reject;
      });
      void entry.released.catch(() => {});
    }
    const completed = entry.released;
    entry.users++;
    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (!released) {
          released = true;
          if (!--entry.users) {
            if (entry.handle && !entry.closing) {
              entry.timer = setTimeout(
                () => this.close(source.key, entry),
                SOURCE_COOLDOWN_MS,
              );
              entry.timer.unref?.();
              entry.resolveReleased();
              this.notify();
            } else this.close(source.key, entry);
          }
        }
        return completed;
      },
    };
  }
  close(key, entry) {
    if (entry.closing) return entry.closed;
    entry.closing = true;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    clearTimeout(entry.timer);
    this.signal.removeEventListener("abort", entry.abort);
    entry.controller.abort(this.signal.reason);
    // Pending decodes retain their reservation until completion and cache acknowledgement.
    void entry.closed.then(entry.resolveReleased, entry.rejectReleased);
    this.closing.add(entry.closed);
    void entry.promise
      .catch(() => {})
      .then(() => entry.handle?.dispose())
      .finally(() => {
        entry.releaseMemory();
        this._cachedBytes -= entry.cacheBytes;
        entry.cacheBytes = 0;
        entry.handle = undefined;
        this.closing.delete(entry.closed);
        this.notify();
      })
      .then(entry.resolveClosed, entry.rejectClosed);
    return entry.closed;
  }
  wake() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  notify() {
    this.wake();
    this.onChange?.();
  }
  async acquireWhenAvailable(source, signal) {
    for (;;) {
      signal.throwIfAborted();
      this.signal.throwIfAborted();
      if (this.disposed)
        throw new DOMException("Scene source cache disposed", "AbortError");
      const lease =
        this.entries.has(source.key) ||
        (!this.closing.size &&
          ![...this.entries.values()].some(
            (entry) => entry.users || entry.pending,
          ))
          ? this.acquire(source)
          : undefined;
      if (lease) return lease;
      let wake;
      const changed = new Promise((resolve) => {
        wake = resolve;
        this.waiters.add(wake);
      });
      try {
        await abortable(changed, signal);
      } finally {
        this.waiters.delete(wake);
      }
    }
  }
  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      for (const [key, entry] of this.entries) this.close(key, entry);
      this.wake();
    }
    const completed = Promise.all(this.closing).then(() => {});
    void completed.catch(() => {});
    return completed;
  }
}
