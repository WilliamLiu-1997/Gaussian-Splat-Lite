import { getTransferable } from "../../../runtime/transferable.js";

// Keep one packed codebook per input. Only copies leave this worker.
const cache = new Map();
self.onmessage = ({ data: { id, name, args } }) => {
  // WorkerRpc also serves WASM workers; this cache needs no WASM instance.
  if (name === "init-wasm") return;
  try {
    let result;
    if (name === "set") {
      cache.set(args.source, args.codebooks);
    } else if (name === "get") {
      const codebooks = cache.get(args.source);
      if (!codebooks) throw new Error("RAD codebook unavailable");
      result = codebooks.map((codes) => codes?.slice());
    } else {
      throw new Error(`Unknown RAD codebook request: ${name}`);
    }
    self.postMessage(
      { id, result, wasmMemoryBytes: 0 },
      { transfer: getTransferable(result) },
    );
  } catch (error) {
    self.postMessage({ id, error, wasmMemoryBytes: 0 });
  }
};
