import init_wasm, {
  type ChunkDecoder,
  decode_to_splats,
  set_sort_center_state,
  sort32_centers,
} from "gaussian-splat-rs";
import type { SplatResult } from "./defines";

const rpcHandlers = {
  setSortCenterState,
  sortCenters32,
  loadSplats,
  nextChunk,
};
export type RpcHandlers = typeof rpcHandlers;

function setSortCenterState({
  updateRangeIndices,
  updateCenters,
  rangeMeshIds,
  rangeBases,
  rangeCounts,
  rangeOrigins,
}: {
  updateRangeIndices: Uint32Array;
  updateCenters: Float32Array;
  rangeMeshIds: Uint32Array;
  rangeBases: Uint32Array;
  rangeCounts: Uint32Array;
  rangeOrigins: Float64Array;
}) {
  set_sort_center_state(
    updateRangeIndices,
    updateCenters,
    rangeMeshIds,
    rangeBases,
    rangeCounts,
    rangeOrigins,
  );
}

function sortCenters32({
  numSplats,
  cameraPosition,
  direction,
  radial,
  ordering,
}: {
  numSplats: number;
  cameraPosition: [number, number, number];
  direction: [number, number, number];
  radial: boolean;
  ordering: Uint32Array;
}) {
  const activeSplats = sort32_centers(
    numSplats,
    cameraPosition[0],
    cameraPosition[1],
    cameraPosition[2],
    direction[0],
    direction[1],
    direction[2],
    radial,
    ordering,
  );
  return { activeSplats, ordering };
}

async function onMessage(event: MessageEvent) {
  const {
    id,
    name,
    args,
  }: { id: unknown; name: keyof typeof rpcHandlers; args: unknown } =
    event.data;
  try {
    const handler = rpcHandlers[name] as (
      args: unknown,
      options: { sendStatus: (data: unknown) => void },
    ) => unknown | Promise<unknown>;
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
    self.postMessage({ id, result }, { transfer: getTransferable(result) });
  } catch (error) {
    console.warn(`Worker error: ${error}`);
    self.postMessage({ id, error }, { transfer: getTransferable(error) });
  }
}

async function decodeBytesUrl({
  decoder,
  fileBytes,
  url,
  requestHeader,
  withCredentials,
  chunked,
  chunkedLength,
  sendStatus,
}: {
  decoder: ChunkDecoder;
  fileBytes?: Uint8Array;
  url?: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  chunked?: boolean;
  chunkedLength?: number;
  sendStatus: (data: unknown) => void;
}) {
  let readStream: ReadableStream<Uint8Array>;
  let streamLength = 0;

  if (fileBytes) {
    readStream = new ReadableStream({
      start(controller) {
        controller.enqueue(fileBytes);
        controller.close();
      },
    });
    streamLength = fileBytes.length;
  } else if (url) {
    const request = new Request(url, {
      headers: requestHeader ? new Headers(requestHeader) : undefined,
      credentials: withCredentials ? "include" : "same-origin",
    });

    const response = await fetch(request);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
      );
    }
    readStream = response.body;
    const contentLength = Number.parseInt(
      response.headers.get("Content-Length") || "0",
    );
    streamLength = Number.isNaN(contentLength) ? 0 : contentLength;
  } else if (chunked) {
    readStream = new ReadableStream(
      {
        async pull(controller) {
          const readNextChunk = new Promise<Uint8Array>((resolve) => {
            nextChunkWaiter = resolve;
          });
          sendStatus({ nextChunk: true });
          const chunk = await readNextChunk;

          if (chunk.length === 0) {
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        },
      },
      { highWaterMark: 0 },
    );
    streamLength = chunkedLength ?? 0;
  } else {
    throw new Error("No url or fileBytes provided");
  }

  const reader = readStream.getReader();
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      loaded += value.length;
      sendStatus({ loaded, total: streamLength });
      decoder.push(value);
    }

    if (chunked && streamLength === 0) {
      sendStatus({ loaded, total: loaded });
    }

    return decoder.finish();
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the decoding error if stream cancellation itself fails.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

type DecodedSplatResult = {
  numSplats: number;
  splat0: Uint32Array;
  splat1: Uint32Array;
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3a?: Uint32Array;
  sh3b?: Uint32Array;
};

function toSplatResult(decoded: DecodedSplatResult): SplatResult {
  return {
    numSplats: decoded.numSplats,
    splatArrays: [decoded.splat0, decoded.splat1],
    extra: {
      sh1: decoded.sh1,
      sh2: decoded.sh2,
      sh3a: decoded.sh3a,
      sh3b: decoded.sh3b,
    },
  };
}

async function loadSplats(
  {
    url,
    requestHeader,
    withCredentials,
    fileBytes,
    fileType,
    pathName,
    chunked,
    chunkedLength,
  }: {
    url?: string;
    requestHeader?: Record<string, string>;
    withCredentials?: boolean;
    fileBytes?: Uint8Array;
    fileType?: string;
    pathName?: string;
    chunked?: boolean;
    chunkedLength?: number;
  },
  { sendStatus }: { sendStatus: (data: unknown) => void },
) {
  const decoder = decode_to_splats(fileType, pathName ?? url);
  const decoded = await decodeBytesUrl({
    decoder,
    fileBytes,
    url,
    requestHeader,
    withCredentials,
    chunked,
    chunkedLength,
    sendStatus,
  });
  return toSplatResult(decoded as DecodedSplatResult);
}

let nextChunkWaiter = (_chunk: Uint8Array) => {};

async function nextChunk({ chunk }: { chunk: Uint8Array }) {
  nextChunkWaiter(chunk);
}

function getTransferable(ctx: unknown): Transferable[] {
  const buffers: Transferable[] = [];
  const seen = new Set();

  function traverse(obj: unknown) {
    if (obj && typeof obj === "object" && !seen.has(obj)) {
      seen.add(obj);

      if (obj instanceof ArrayBuffer) {
        buffers.push(obj);
      } else if (ArrayBuffer.isView(obj)) {
        buffers.push(obj.buffer as ArrayBuffer);
      } else if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else {
        Object.values(obj).forEach(traverse);
      }
    }
  }

  traverse(ctx);
  return buffers;
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

  await init_wasm({ module_or_path: await waitForModule });

  self.removeEventListener("message", bufferMessage);
  self.addEventListener("message", onMessage);

  for (const event of pending) {
    onMessage(event);
  }
  pending.length = 0;
}

initialize().catch(console.error);
