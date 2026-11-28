import { PAUSED } from "../bin/run-state.js";
import { pauseClock, runTime, startClock } from "./runtime/clock.js";

export function requireIsolation() {
  if (!globalThis.crossOriginIsolated)
    throw new Error(
      "Browser conversion requires cross-origin isolation (COOP/COEP).",
    );
}

export class ConversionController extends AbortController {
  constructor() {
    super();
    requireIsolation();
    this.clock = startClock();
    this.state = new Int32Array(new SharedArrayBuffer(4));
  }

  get paused() {
    return Atomics.load(this.state, 0) === PAUSED;
  }

  get elapsedMilliseconds() {
    return runTime(this.clock);
  }

  pause() {
    if (this.signal.aborted || this.paused) return;
    pauseClock(this.clock, true);
    Atomics.store(this.state, 0, PAUSED);
  }

  resume() {
    if (!this.paused) return;
    pauseClock(this.clock, false);
    Atomics.store(this.state, 0, 0);
    Atomics.notify(this.state, 0);
  }

  async waitWhilePaused() {
    while (this.paused) await Atomics.waitAsync(this.state, 0, PAUSED).value;
  }

  abort(reason) {
    if (this.signal.aborted) return;
    if (!this.paused) pauseClock(this.clock, true);
    Atomics.store(this.state, 0, 1);
    Atomics.notify(this.state, 0);
    super.abort(reason);
  }
}
