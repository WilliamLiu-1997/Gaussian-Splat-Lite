// Positive values are cancellation codes, including CLI signal exit codes.
export const PAUSED = -1;

export function cancellationCode(state) {
  if (!state) return 0;
  let value = Atomics.load(state, 0);
  while (value === PAUSED) {
    Atomics.wait(state, 0, PAUSED);
    value = Atomics.load(state, 0);
  }
  return value;
}

export function checkRun(state) {
  if (cancellationCode(state)) throw new Error("Conversion cancelled");
}
