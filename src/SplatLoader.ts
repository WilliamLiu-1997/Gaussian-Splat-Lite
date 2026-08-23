import { Loader } from "three";
import { SplatMesh } from "./SplatMesh";
import { workerPool } from "./SplatWorker";
import { Splats, type SplatsOptions } from "./Splats";
import type { SplatFileType } from "./defines";

// SplatLoader implements the THREE.Loader interface for PLY and SPZ files.
export class SplatLoader extends Loader {
  load(
    url: string,
    onLoad?: (decoded: Splats) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }

  async loadAsync(
    url: string,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<Splats> {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, onProgress, reject);
    });
  }

  parse(splats: Splats): SplatMesh {
    return new SplatMesh({ splats });
  }

  loadInternal({
    splats,
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
    splats?: Splats;
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    streamLength?: number;
    onLoad?: (decoded: Splats) => void;
    onProgress?: (event: ProgressEvent) => void;
    onError?: (error: unknown) => void;
  }) {
    const byteArray =
      fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
    const resolvedURL = byteArray
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
            try {
              onProgress(
                new ProgressEvent("progress", {
                  lengthComputable: total !== 0,
                  loaded,
                  total: total ?? 0,
                }),
              );
            } catch (error) {
              console.error("Progress callback failed", error);
            }
          }

          if ((data as { nextChunk?: boolean }).nextChunk) {
            let chunk: Uint8Array;
            if (!readStream) {
              chunk = new Uint8Array(0);
            } else {
              const { done, value } = await readStream
                .read()
                .catch(async (error) => {
                  await worker.call("nextChunk", { chunk: new Uint8Array(0) });
                  throw error;
                });
              if (done) {
                readStream.releaseLock();
                readStream = undefined;
                chunk = new Uint8Array(0);
              } else {
                chunk = value;
              }
            }
            await worker.call("nextChunk", { chunk });
          }
        };

        const basedUrl = resolvedURL
          ? new URL(resolvedURL, window.location.href).toString()
          : undefined;
        const decoded = await worker.call(
          "loadSplats",
          {
            url: basedUrl,
            requestHeader: this.requestHeader,
            withCredentials: this.withCredentials,
            fileBytes: byteArray?.slice(),
            fileType,
            pathName: resolvedURL || fileName,
            chunked: stream !== undefined,
            chunkedLength: streamLength,
          },
          { onStatus },
        );

        const result = splats ?? new Splats();
        result.initialize(decoded as SplatsOptions);
        onLoad?.(result);
      })
      .catch(async (error) => {
        if (readStream) {
          try {
            await readStream.cancel(error);
          } catch {
            // Preserve the worker decoding error if stream cancellation fails.
          }
          readStream.releaseLock();
          readStream = undefined;
        }
        this.manager.itemError(resolvedURL ?? "");
        onError?.(error);
      })
      .finally(() => {
        this.manager.itemEnd(resolvedURL ?? "");
      });
  }

  async loadInternalAsync({
    splats,
    url,
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    onProgress,
  }: {
    splats?: Splats;
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    streamLength?: number;
    onProgress?: (event: ProgressEvent) => void;
  }): Promise<Splats> {
    return new Promise((resolve, reject) => {
      this.loadInternal({
        splats,
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
