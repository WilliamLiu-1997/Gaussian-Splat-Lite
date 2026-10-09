import init_wasm from "gaussian-splat-rs";
import { getTransferable } from "./transferable.js";
import { isMemoryAllocationError, wasmFailure } from "./wasmCall.js";
/** Start a worker with its own RPC table and WASM instance. */
export function startWorker(rpcHandlers) {
  let wasmMemory;
  async function onMessage(event) {
    const { id, name, args } = event.data;
    try {
      const failure = wasmFailure();
      if (failure.failed) throw failure.error;
      const handler = rpcHandlers[name];
      const sendStatus = (data) => {
        self.postMessage(
          { id, status: data },
          { transfer: getTransferable(data) },
        );
      };
      const result = await handler(args, { sendStatus });
      self.postMessage(
        { id, result, wasmMemoryBytes: wasmMemory.buffer.byteLength },
        { transfer: getTransferable(result) },
      );
    } catch (caught) {
      const failure = wasmFailure();
      const context = args;
      const label =
        context?.pathName ??
        context?.url ??
        context?.request?.resourceUrl ??
        name;
      const message = `${label}: ${caught instanceof Error || caught instanceof DOMException ? caught.message : String(caught)}`;
      // DOMException.message and user errors can be read-only. Never mutate
      // the thrown object; retain transport/abort types on the new error.
      const error =
        caught instanceof DOMException
          ? new DOMException(message, caught.name)
          : caught instanceof TypeError
            ? new TypeError(message)
            : caught instanceof RangeError
              ? new RangeError(message)
              : new Error(message);
      if (caught instanceof Error && !(error instanceof DOMException)) {
        error.name = caught.name;
        error.stack = caught.stack;
      }
      if (error.name !== "AbortError") console.warn(`Worker error: ${error}`);
      self.postMessage(
        {
          id,
          error,
          fatal: failure.failed || isMemoryAllocationError(caught),
          wasmMemoryBytes: wasmMemory.buffer.byteLength,
        },
        { transfer: getTransferable(error) },
      );
    }
  }
  async function initialize() {
    let resolveWaitForModule;
    const waitForModule = new Promise((resolve) => {
      resolveWaitForModule = resolve;
    });
    const pending = [];
    const bufferMessage = (event) => {
      if (event.data.name === "init-wasm") {
        resolveWaitForModule(event.data.module);
        return;
      }
      pending.push(event);
    };
    self.addEventListener("message", bufferMessage);
    const wasm = await init_wasm({ module_or_path: await waitForModule });
    wasmMemory = wasm.memory;
    self.removeEventListener("message", bufferMessage);
    self.addEventListener("message", onMessage);
    for (const event of pending) {
      onMessage(event);
    }
  }
  void initialize().catch((error) => {
    setTimeout(() => {
      throw error;
    });
  });
}
