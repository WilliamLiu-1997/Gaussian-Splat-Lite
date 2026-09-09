import init_wasm from "gaussian-splat-rs";
import { getTransferable } from "./transferable";

/** Start a worker with its own RPC table and WASM instance. */
export function startWorker(
  rpcHandlers: Record<string, (...args: never[]) => unknown>,
) {
  let wasmMemory: WebAssembly.Memory | undefined;
  function getWasmMemoryBytes() {
    return wasmMemory?.buffer.byteLength ?? 0;
  }

  async function onMessage(event: MessageEvent) {
    const { id, name, args }: { id: unknown; name: string; args: unknown } =
      event.data;
    try {
      const handler = Object.prototype.hasOwnProperty.call(rpcHandlers, name)
        ? (rpcHandlers[name] as (
            args: unknown,
            options: { sendStatus: (data: unknown) => void },
          ) => unknown | Promise<unknown>)
        : undefined;
      if (!handler) {
        throw new Error(`Unknown worker RPC: ${name}`);
      }

      const sendStatus = (data: unknown) => {
        self.postMessage(
          { id, status: data },
          { transfer: getTransferable(data) },
        );
      };
      const result = await handler(args, { sendStatus });
      self.postMessage(
        { id, result, wasmMemoryBytes: getWasmMemoryBytes() },
        { transfer: getTransferable(result) },
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        console.warn(`Worker error: ${error}`);
      self.postMessage(
        { id, error, wasmMemoryBytes: getWasmMemoryBytes() },
        { transfer: getTransferable(error) },
      );
    }
  }

  async function initialize() {
    let resolveWaitForModule: (value: WebAssembly.Module) => void;
    const waitForModule = new Promise<WebAssembly.Module>((resolve) => {
      resolveWaitForModule = resolve;
    });

    const pending: MessageEvent[] = [];
    const bufferMessage = (event: MessageEvent) => {
      if (event.data.name === "init-wasm") {
        resolveWaitForModule(event.data.module as WebAssembly.Module);
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
    pending.length = 0;
  }

  void initialize().catch((error) => {
    setTimeout(() => {
      throw error;
    });
  });
}
