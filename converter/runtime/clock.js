let clock;

// Workers have their own time origin. Use the same monotonic timeline in all of them.
const now = () =>
  Math.round((performance.timeOrigin + performance.now()) * 1000);

export function useClock(shared) {
  clock = shared;
}

export function startClock() {
  const clock = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(clock, 0, BigInt(now()));
  return clock;
}

// A running clock stores its start time. A paused clock stores negated elapsed time.
export function pauseClock(clock, paused) {
  const value = Atomics.load(clock, 0);
  const time = BigInt(now());
  Atomics.store(clock, 0, paused ? value - time : value + time);
}

export function runTime(shared = clock) {
  for (;;) {
    const value = Atomics.load(shared, 0);
    if (value <= 0n) return Number(-value) / 1000;
    const elapsed = now() - Number(value);
    if (Atomics.load(shared, 0) === value) return elapsed / 1000;
  }
}
