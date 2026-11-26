import { PAUSED } from "../bin/run-state.js";
import { pauseClock, startClock } from "./runtime/clock.js";

export class ConversionRun extends AbortController {
  clock = startClock();
  state = new Int32Array(new SharedArrayBuffer(4));

  get paused() {
    return Atomics.load(this.state, 0) === PAUSED;
  }

  setPaused(paused) {
    if (paused === this.paused) return;
    pauseClock(paused);
    Atomics.store(this.state, 0, paused ? PAUSED : 0);
    if (!paused) Atomics.notify(this.state, 0);
  }

  async waitWhilePaused() {
    while (this.paused) await Atomics.waitAsync(this.state, 0, PAUSED).value;
  }

  abort() {
    Atomics.store(this.state, 0, 1);
    Atomics.notify(this.state, 0);
    super.abort();
  }
}
