import init_wasm, {
  type ChunkDecoder,
  decode_to_extsplats,
  decode_to_packedsplats,
  sort32_splats,
} from "spark-worker-rs";
import type { ExtResult, PackedResult, SplatEncoding } from "./defines";

const rpcHandlers = {
  sortSplats32,
  loadPackedSplats,
  loadExtSplats,
  nextChunk,
};
export type RpcHandlers = typeof rpcHandlers;

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

function sortSplats32({
  numSplats,
  readback,
  ordering,
}: {
  numSplats: number;
  readback: Uint32Array;
  ordering: Uint32Array;
}) {
  const activeSplats = sort32_splats(numSplats, readback, ordering);
  return { activeSplats, readback, ordering };
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

type DecodedPackedResult = {
  numSplats: number;
  packed: Uint32Array;
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3?: Uint32Array;
  splatEncoding: SplatEncoding;
};

function toPackedResult(packed: DecodedPackedResult): PackedResult {
  return {
    numSplats: packed.numSplats,
    packedArray: packed.packed,
    extra: {
      sh1: packed.sh1,
      sh2: packed.sh2,
      sh3: packed.sh3,
    },
    splatEncoding: packed.splatEncoding,
  };
}

async function loadPackedSplats(
  {
    url,
    requestHeader,
    withCredentials,
    fileBytes,
    fileType,
    pathName,
    chunked,
    chunkedLength,
    encoding,
  }: {
    url?: string;
    requestHeader?: Record<string, string>;
    withCredentials?: boolean;
    fileBytes?: Uint8Array;
    fileType?: string;
    pathName?: string;
    chunked?: boolean;
    chunkedLength?: number;
    encoding?: SplatEncoding;
  },
  { sendStatus }: { sendStatus: (data: unknown) => void },
) {
  const decoder = decode_to_packedsplats(fileType, pathName ?? url, encoding);
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
  return toPackedResult(decoded as DecodedPackedResult);
}

type DecodedExtResult = {
  numSplats: number;
  ext0: Uint32Array;
  ext1: Uint32Array;
  sh1?: Uint32Array;
  sh2?: Uint32Array;
  sh3a?: Uint32Array;
  sh3b?: Uint32Array;
};

function toExtResult(packed: DecodedExtResult): ExtResult {
  return {
    numSplats: packed.numSplats,
    extArrays: [packed.ext0, packed.ext1],
    extra: {
      sh1: packed.sh1,
      sh2: packed.sh2,
      sh3a: packed.sh3a,
      sh3b: packed.sh3b,
    },
  };
}

async function loadExtSplats(
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
  const decoder = decode_to_extsplats(fileType, pathName ?? url);
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
  return toExtResult(decoded as DecodedExtResult);
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
  const pending: MessageEvent[] = [];
  const bufferMessage = (event: MessageEvent) => {
    pending.push(event);
  };
  self.addEventListener("message", bufferMessage);

  await init_wasm();

  self.removeEventListener("message", bufferMessage);
  self.addEventListener("message", onMessage);

  for (const event of pending) {
    onMessage(event);
  }
  pending.length = 0;
}

initialize().catch(console.error);
