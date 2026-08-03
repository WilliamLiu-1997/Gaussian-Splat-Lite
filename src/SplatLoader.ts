import { Loader } from "three";
import type { ExtSplats, ExtSplatsOptions } from "./ExtSplats";
import { PackedSplats, type PackedSplatsOptions } from "./PackedSplats";
import { SplatMesh } from "./SplatMesh";
import { workerPool } from "./SplatWorker";
import type { SplatEncoding, SplatFileType } from "./defines";

// SplatLoader implements the THREE.Loader interface for PLY and SPZ files.
export class SplatLoader extends Loader {
  load(
    url: string,
    onLoad?: (decoded: PackedSplats | ExtSplats) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }

  async loadAsync(
    url: string,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<PackedSplats | ExtSplats> {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, onProgress, reject);
    });
  }

  parse(packedSplats: PackedSplats): SplatMesh {
    return new SplatMesh({ packedSplats });
  }

  loadInternal({
    packedSplats,
    extSplats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onLoad,
    onProgress,
    onError,
  }: {
    packedSplats?: PackedSplats;
    extSplats?: ExtSplats;
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    streamLength?: number;
    onLoad?: (decoded: PackedSplats | ExtSplats) => void;
    onProgress?: (event: ProgressEvent) => void;
    onError?: (error: unknown) => void;
  }) {
    if (fileBytes instanceof ArrayBuffer) {
      fileBytes = new Uint8Array(fileBytes);
    }
    const resolvedURL = fileBytes
      ? undefined
      : this.manager.resolveURL((this.path ?? "") + (url ?? ""));
    let readStream = stream?.getReader();

    this.manager.itemStart(resolvedURL ?? "");

    workerPool
      .withWorker(async (worker) => {
        const onStatus = async (data: unknown) => {
          const { loaded, total } = data as {
            loaded?: number;
            total?: number;
          };
          if (loaded !== undefined && onProgress) {
            onProgress(
              new ProgressEvent("progress", {
                lengthComputable: total !== 0,
                loaded,
                total: total ?? 0,
              }),
            );
          }

          if ((data as { nextChunk?: boolean }).nextChunk) {
            let chunk: Uint8Array;
            if (!readStream) {
              chunk = new Uint8Array(0);
            } else {
              const { done, value } = await readStream.read();
              if (done) {
                readStream.releaseLock();
                readStream = undefined;
                chunk = new Uint8Array(0);
              } else {
                chunk = value;
              }
            }
            worker.call("nextChunk", { chunk });
          }
        };

        const basedUrl = resolvedURL
          ? new URL(resolvedURL, window.location.href).toString()
          : undefined;
        const decoded = (await worker.call(
          extSplats ? "loadExtSplats" : "loadPackedSplats",
          {
            url: basedUrl,
            requestHeader: this.requestHeader,
            withCredentials: this.withCredentials,
            fileBytes: fileBytes?.slice(),
            fileType,
            pathName: resolvedURL || fileName,
            chunked: stream !== undefined,
            chunkedLength: streamLength,
            encoding: packedSplats?.splatEncoding,
          },
          { onStatus },
        )) as {
          numSplats: number;
          packedArray?: Uint32Array;
          extArrays?: [Uint32Array, Uint32Array];
          extra: Record<string, unknown>;
          splatEncoding?: SplatEncoding;
        };

        if (extSplats) {
          extSplats.initialize(decoded as ExtSplatsOptions);
          onLoad?.(extSplats);
        } else if (packedSplats) {
          packedSplats.initialize(decoded as PackedSplatsOptions);
          onLoad?.(packedSplats);
        } else {
          onLoad?.(new PackedSplats(decoded as PackedSplatsOptions));
        }
      })
      .catch((error) => {
        this.manager.itemError(resolvedURL ?? "");
        onError?.(error);
      })
      .finally(() => {
        this.manager.itemEnd(resolvedURL ?? "");
      });
  }

  async loadInternalAsync({
    packedSplats,
    extSplats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onProgress,
  }: {
    packedSplats?: PackedSplats;
    extSplats?: ExtSplats;
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    streamLength?: number;
    onProgress?: (event: ProgressEvent) => void;
  }): Promise<PackedSplats | ExtSplats> {
    return new Promise((resolve, reject) => {
      this.loadInternal({
        packedSplats,
        extSplats,
        url,
        fileBytes,
        fileType,
        fileName,
        stream,
        streamLength,
        onLoad: resolve,
        onProgress,
        onError: reject,
      });
    });
  }
}
