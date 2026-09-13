import init_wasm from "gaussian-splat-rs";
import { getTransferable } from "./transferable";

/** Start a worker with its own RPC table and WASM instance. */
export function startWorker(
  rpcHandlers: Record<string, (...args: never[]) => unknown>,
) {
  let wasmMemory: WebAssembly.Memory;

  async function onMessage(event: MessageEvent) {
    const { id, name, args }: { id: unknown; name: string; args: unknown } =
      event.data;
    try {
      const handler = rpcHandlers[name] as (
        args: unknown,
        options: { sendStatus: (data: unknown) => void },
      ) => unknown;

      const sendStatus = (data: unknown) => {
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
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        console.warn(`Worker error: ${error}`);
      self.postMessage(
        { id, error, wasmMemoryBytes: wasmMemory.buffer.byteLength },
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
  }

  void initialize().catch((error) => {
    setTimeout(() => {
      throw error;
    });
  });
}
